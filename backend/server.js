require('dotenv').config({ quiet: true });
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { cifrar, decifrar, indice, chaveValida: dadosKeyOk } = require('./cripto');
const { chaveTelefone } = require('./whatsapp');

// DATA_DIR: aponte para um disco persistente em produção (ex.: /var/data no Render).
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const db = new Database(path.join(DATA_DIR, 'apple-green.db'));
// WAL deixa as gravações bem mais rápidas (sem fsync completo a cada INSERT) e permite ler enquanto grava.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
const SEGREDO_DEV = 'apple_green_secret_dev';
const JWT_SECRET = process.env.JWT_SECRET || SEGREDO_DEV;
// Em produção o servidor não sobe sem um segredo próprio e forte: com o segredo de desenvolvimento (que
// está no código) qualquer pessoa conseguiria gerar uma sessão de outro usuário, inclusive do master.
// O login sem senha (DEV_SEM_LOGIN) também é proibido em produção.
if (process.env.NODE_ENV === 'production') {
  const erros = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === SEGREDO_DEV) erros.push('JWT_SECRET não definido');
  else if (process.env.JWT_SECRET.length < 32) erros.push('JWT_SECRET curto demais (use 32 caracteres ou mais, ex.: openssl rand -hex 32)');
  if (process.env.DEV_SEM_LOGIN === '1') erros.push('DEV_SEM_LOGIN não pode estar ligado em produção');
  if (!dadosKeyOk) erros.push('DADOS_KEY não definida (64 caracteres hex, ex.: openssl rand -hex 32) — cifra CPF, e-mail e telefone');
  if (erros.length) {
    console.error(`[erro] O servidor não vai subir: ${erros.join('; ')}.`);
    process.exit(1);
  }
} else if (!process.env.JWT_SECRET || !dadosKeyOk) {
  console.warn('[atenção] JWT_SECRET e/ou DADOS_KEY não definidos: usando chaves de desenvolvimento. Em produção (NODE_ENV=production) o servidor recusa subir assim.');
}
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4300';

// maxAge: o navegador guarda a resposta do preflight (OPTIONS) e não repete essa ida extra a cada gravação.
// Atrás do proxy do Render, o IP real vem no X-Forwarded-For (1 salto). Sem isso o limite de tentativas
// enxerga um IP só para todo mundo. TRUST_PROXY ajusta o número de saltos (0 = sem proxy).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? 1 : 0)));
app.disable('x-powered-by');
// Cabeçalhos de segurança: a API só devolve JSON (e a página de retorno do Google), nada pode ser embutido
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'cross-origin', // as imagens de /uploads aparecem no app (outra origem)
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({ origin: FRONTEND_URL, credentials: true, maxAge: 86400 }));

// Registra pedidos lentos para facilitar o diagnóstico.
app.use((req, res, next) => {
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (ms > 300) console.warn(`[lento] ${req.method} ${req.originalUrl} → ${res.statusCode} em ${Math.round(ms)} ms`);
  });
  next();
});
// A fatura chega em base64 dentro do JSON (PDFs de alguns MB); só essa rota aceita corpo grande.
app.use('/faturas/importar', express.json({ limit: '20mb' }));
app.use('/admin/uploads', express.json({ limit: '8mb' })); // imagens do anúncio e dos avisos (master)
app.use(express.json());
// Nenhum texto enviado pelo app passa de 5.000 caracteres (exceto a fatura e as imagens, que têm rota própria)
const ROTAS_CORPO_GRANDE = ['/faturas/importar', '/admin/uploads'];
function textoLongo(v, prof = 0) {
  if (typeof v === 'string') return v.length > 5000;
  if (v && typeof v === 'object' && prof < 6) return Object.values(v).some((x) => textoLongo(x, prof + 1));
  return false;
}
app.use((req, res, next) => {
  if (req.body && !ROTAS_CORPO_GRANDE.some((r) => req.path.startsWith(r)) && textoLongo(req.body)) {
    return res.status(413).json({ erro: 'Texto longo demais.' });
  }
  next();
});

// Último acesso de cada usuário (nível de utilização no painel master): grava no máximo a cada 10 min
const ultimoAcessoGravado = new Map();
app.use((req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const { id } = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (id && Date.now() - (ultimoAcessoGravado.get(id) || 0) > 10 * 60 * 1000) {
        ultimoAcessoGravado.set(id, Date.now());
        db.prepare('UPDATE usuarios SET ultimo_acesso = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      }
    } catch { /* token inválido: a rota responde */ }
  }
  next();
});

// Limites de tentativas, cada fluxo com o seu contador (um não esgota o outro)
const limitador = (windowMs, limit, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, ...extra,
});
const loginLimiter = limitador(15 * 60 * 1000, 20);          // login e consulta de convite, por IP
const loginEmailLimiter = limitador(15 * 60 * 1000, 10, {      // login, por e-mail: senha tentada de vários IPs
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `email:${String(req.body?.email || '').trim().toLowerCase()}`,
});
const cadastroLimiter = limitador(60 * 60 * 1000, 10);         // cadastros por IP
const confirmarLimiter = limitador(15 * 60 * 1000, 20);        // confirmação de e-mail e redefinição de senha
const emailLimiter = limitador(60 * 60 * 1000, 5);             // pedidos que disparam e-mail ("esqueci a senha")
// Rotas que chamam a IA (custo por chamada): por usuário logado, use depois de auth()
const iaLimiter = limitador(60 * 60 * 1000, 40, {
  keyGenerator: (req) => `usuario:${req.user.id}`,
  message: { erro: 'Limite de uso da inteligência artificial atingido. Tente novamente em uma hora.' },
});

// ── Google OAuth2 (envio de e-mail) ───────────────────────
const TOKEN_PATH = path.join(DATA_DIR, 'google_token.json');
const CREDENTIALS_PATH = path.join(DATA_DIR, 'google_credentials.json');

function getOAuth2Client() {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  const { client_id, client_secret, redirect_uris } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH)).web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function getAuthorizedClient() {
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client || !fs.existsSync(TOKEN_PATH)) return null;
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  return oAuth2Client;
}

// A conta do Gmail que envia os e-mails do sistema só pode ser conectada pelo master.
// Abra /auth/google?token=<sessão do master>; o `state` amarra a volta do Google a esse pedido.
const estadosGoogle = new Map(); // state → expira em (ms)
const paginaSimples = (texto) => `<!doctype html><meta charset="utf-8"><p>${escaparHtml(texto)}</p>`;

app.get('/auth/google', (req, res) => {
  const sessao = lerSessao(String(req.query.token || ''));
  if (!sessao || !usuarioEhMaster(sessao.id)) return res.status(403).send(paginaSimples('Acesso restrito ao master.'));
  const oAuth2Client = getOAuth2Client();
  if (!oAuth2Client) return res.status(500).send(paginaSimples('google_credentials.json não encontrado. Configure as credenciais OAuth2.'));
  for (const [s, exp] of estadosGoogle) if (exp < Date.now()) estadosGoogle.delete(s);
  const state = crypto.randomBytes(24).toString('hex');
  estadosGoogle.set(state, Date.now() + 10 * 60 * 1000);
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.send'],
    prompt: 'consent',
    state,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const exp = estadosGoogle.get(String(state || ''));
  estadosGoogle.delete(String(state || ''));
  if (!exp || exp < Date.now()) return res.status(400).send(paginaSimples('Pedido de autorização inválido ou expirado. Comece de novo.'));
  if (error) return res.status(400).send(paginaSimples(`O Google recusou a autorização (${String(error).slice(0, 80)}).`));
  const oAuth2Client = getOAuth2Client();
  try {
    const response = await oAuth2Client.getToken(String(code));
    const tokens = response.tokens ?? response;
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens), { mode: 0o600 });
    res.send(paginaSimples('Autenticação concluída! Pode fechar esta aba.'));
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send(paginaSimples('Erro na autenticação. Veja o log do servidor.'));
  }
});

app.get('/auth/google/status', auth(), (req, res) => {
  if (!usuarioEhMaster(req.user.id)) return res.status(403).json({ erro: 'Acesso restrito ao master' });
  res.json({ autenticado: fs.existsSync(TOKEN_PATH) && fs.existsSync(CREDENTIALS_PATH) });
});

// E-mail aceito no cadastro e nos convites: formato simples, sem espaços, quebras de linha nem separadores
// de lista (que permitiriam incluir outros destinatários ou cabeçalhos no envio)
const emailValido = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(e);

async function enviarEmail(destinatario, assunto, htmlBody) {
  if (!emailValido(destinatario)) throw new Error('E-mail do destinatário inválido');
  const authClient = getAuthorizedClient();
  if (!authClient) throw new Error('Google não autorizado. Acesse /auth/google para autorizar o envio de e-mails.');
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const mensagem = [
    `To: ${destinatario}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    `Subject: =?UTF-8?B?${Buffer.from(assunto).toString('base64')}?=`,
    '',
    htmlBody,
  ].join('\r\n');
  const raw = Buffer.from(mensagem).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ── Usuários ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    confirmado INTEGER NOT NULL DEFAULT 0,
    token_confirmacao TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_usuarios_token_confirmacao ON usuarios(token_confirmacao)');

// sessao_versao: sobe a cada troca de senha ou "sair de todos os aparelhos" e derruba as sessões antigas.
// reset_hash/reset_expira: código de "esqueci minha senha" (só o hash fica no banco), vale 1 hora.
try { db.prepare('ALTER TABLE usuarios ADD COLUMN sessao_versao INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE usuarios ADD COLUMN reset_hash TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE usuarios ADD COLUMN reset_expira INTEGER').run(); } catch {}

// Sessão válida → { id, nome, email } lidos do banco (nome e e-mail sempre atuais); senão null
function lerSessao(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const u = db.prepare('SELECT id, nome, email, sessao_versao FROM usuarios WHERE id = ?').get(p.id);
    if (!u || u.sessao_versao !== (p.v ?? 0)) return null;
    return { id: u.id, nome: u.nome, email: u.email };
  } catch {
    return null;
  }
}

function auth() {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ erro: 'Não autenticado' });
    const sessao = lerSessao(token);
    if (!sessao) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    req.user = sessao;
    next();
  };
}

function gerarToken(usuario) {
  return jwt.sign({ id: usuario.id, v: usuario.sessao_versao ?? 0 }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
}

// Mesma regra do master() de admin.js (papel 'master' ou e-mail em MASTER_EMAILS)
function usuarioEhMaster(id) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  const emails = String(process.env.MASTER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!u && (u.papel === 'master' || emails.includes(String(u.email).toLowerCase()));
}

// Comparação em tempo constante (não revela, pelo tempo de resposta, quantos caracteres bateram)
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest();
const iguaisSeguro = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

// Senha: 8 a 128 caracteres (o bcrypt ignora o que passa de 72 bytes)
const SENHA_MIN = 8;
const erroSenha = (s) => typeof s !== 'string' || s.length < SENHA_MIN ? `A senha deve ter no mínimo ${SENHA_MIN} caracteres`
  : s.length > 128 ? 'A senha deve ter no máximo 128 caracteres' : null;
// Hash de referência: o login sem usuário gasta o mesmo tempo que o login com senha errada
const HASH_FALSO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const escaparHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function enviarEmailConfirmacao(nome, email, token) {
  const link = `${FRONTEND_URL}/confirmar-email?token=${token}&email=${encodeURIComponent(email)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
      <div style="background:#05261a;border-radius:14px;padding:32px;text-align:center;">
        <div style="font-size:22px;font-weight:600;letter-spacing:-0.4px;margin-bottom:16px;">
          <span style="color:#f7f8f5;">ze</span><span style="color:#b8f15a;">vem</span></div>
        <h2 style="color:#f7f8f5;margin:0 0 8px;">Bem-vindo(a), ${escaparHtml(nome)}!</h2>
        <p style="color:#a8bcb0;font-size:14px;line-height:1.6;margin:0 0 24px;">
          Confirme seu e-mail para começar seu planejamento financeiro guiado.
        </p>
        <a href="${link}" style="display:inline-block;background:#b8f15a;color:#05261a;
          padding:14px 32px;border-radius:10px;font-weight:800;text-decoration:none;font-size:14px;">
          Confirmar e-mail
        </a>
      </div>
    </div>`;
  await enviarEmail(email, 'Confirme seu e-mail — Zevem', html);
}

// E-mail sem espaços nas pontas e em minúsculas: "Fulano@Gmail.com " e "fulano@gmail.com" são a mesma conta.
const normalizarEmail = (e) => String(e || '').trim().toLowerCase();

// Convites do master (ver convites.js); registrado lá embaixo, junto da área master
let convites = null;

app.post('/auth/cadastro', cadastroLimiter, async (req, res) => {
  const { senha } = req.body;
  const nome = String(req.body.nome ?? '').trim().slice(0, 100);
  const email = normalizarEmail(req.body.email);
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });
  if (!emailValido(email)) return res.status(400).json({ erro: 'Informe um e-mail válido' });
  const problemaSenha = erroSenha(senha);
  if (problemaSenha) return res.status(400).json({ erro: problemaSenha });

  // E-mail que já tem conta: a resposta é igual à de um cadastro novo (não revela quem é cliente);
  // o dono do e-mail recebe um aviso com o caminho para entrar ou criar nova senha.
  const existente = db.prepare('SELECT id, nome FROM usuarios WHERE lower(trim(email)) = ?').get(email);
  if (existente) {
    if (req.body.convite) return res.status(400).json({ erro: 'Este convite não vale mais. Peça um novo a quem te convidou.' });
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
        <div style="background:#05261a;border-radius:14px;padding:32px;text-align:center;color:#f7f8f5;">
          <h2 style="margin:0 0 8px;">Olá, ${escaparHtml(existente.nome)}!</h2>
          <p style="color:#a8bcb0;font-size:14px;line-height:1.6;margin:0 0 24px;">
            Alguém tentou criar uma conta no Zevem com este e-mail, mas você já tem uma.<br>
            Se foi você, entre com sua senha ou crie uma nova. Se não foi, ignore esta mensagem.</p>
          <a href="${FRONTEND_URL}/redefinir-senha" style="display:inline-block;background:#b8f15a;color:#05261a;
            padding:14px 32px;border-radius:10px;font-weight:800;text-decoration:none;font-size:14px;">Criar nova senha</a>
        </div>
      </div>`;
    enviarEmail(email, 'Você já tem conta no Zevem', html).catch((e) => console.error('[cadastro] aviso de conta existente:', e.message));
    // Mesmo aviso que um cadastro novo receberia com o envio de e-mail fora do ar
    const aviso = getAuthorizedClient() ? null : 'Cadastro criado, mas não foi possível enviar o e-mail de confirmação. Tente novamente mais tarde.';
    return res.status(201).json({ ok: true, aviso_email: aviso });
  }

  const senha_hash = await bcrypt.hash(senha, 10);

  // Pelo convite: o link chegou neste e-mail, então a conta já nasce confirmada e entra direto
  if (req.body.convite) {
    const convite = convites?.buscarValido(String(req.body.convite));
    if (!convite) return res.status(400).json({ erro: 'Este convite não vale mais. Peça um novo a quem te convidou.' });
    if (convite.email !== email) return res.status(400).json({ erro: 'Use o e-mail para o qual o convite foi enviado.' });
    const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, confirmado) VALUES (?, ?, ?, 1)').run(nome, email, senha_hash);
    convites.marcarUsado(convite.id, r.lastInsertRowid);
    const usuario = { id: r.lastInsertRowid, nome, email };
    return res.status(201).json({ ok: true, id: usuario.id, aviso_email: null, token: gerarToken(usuario), nome, email });
  }

  const token_confirmacao = crypto.randomBytes(24).toString('hex');
  const r = db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, token_confirmacao) VALUES (?, ?, ?, ?)'
  ).run(nome, email, senha_hash, token_confirmacao);

  let avisoEmail = null;
  try {
    await enviarEmailConfirmacao(nome, email, token_confirmacao);
  } catch (e) {
    console.error('[cadastro] falha ao enviar a confirmação:', e.message);
    avisoEmail = 'Cadastro criado, mas não foi possível enviar o e-mail de confirmação. Tente novamente mais tarde.';
  }
  res.status(201).json({ ok: true, id: r.lastInsertRowid, aviso_email: avisoEmail });
});

// A sessão só sai junto com a confirmação: um link já usado não entra mais na conta (a pessoa faz login)
app.post('/auth/confirmar-email', confirmarLimiter, (req, res) => {
  const token = String(req.body.token || '');
  const email = normalizarEmail(req.body.email);
  if (!email || !token) return res.status(400).json({ erro: 'E-mail e token são obrigatórios' });

  const usuario = db.prepare('SELECT * FROM usuarios WHERE lower(trim(email)) = ?').get(email);
  if (usuario?.confirmado) return res.json({ ok: true, jaConfirmado: true });
  if (!usuario || !usuario.token_confirmacao || !iguaisSeguro(usuario.token_confirmacao, token)) {
    return res.status(401).json({ erro: 'Link de confirmação inválido' });
  }

  db.prepare('UPDATE usuarios SET confirmado = 1, token_confirmacao = NULL WHERE id = ?').run(usuario.id);
  res.json({ ok: true, token: gerarToken(usuario), nome: usuario.nome, email: usuario.email });
});

app.post('/auth/login', loginLimiter, loginEmailLimiter, async (req, res) => {
  const senha = typeof req.body.senha === 'string' ? req.body.senha.slice(0, 128) : '';
  const usuario = db.prepare('SELECT * FROM usuarios WHERE lower(trim(email)) = ?').get(normalizarEmail(req.body.email));
  const confere = await bcrypt.compare(senha, usuario?.senha_hash || HASH_FALSO);
  if (!usuario || !confere) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
  }
  if (!usuario.confirmado) {
    return res.status(403).json({ erro: 'EMAIL_NAO_CONFIRMADO', mensagem: 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.' });
  }
  res.json({ token: gerarToken(usuario), nome: usuario.nome, email: usuario.email });
});

app.get('/auth/me', auth(), (req, res) => res.json(req.user));

// ── Senha: esqueci, redefinir e trocar ──
// A resposta é sempre a mesma, exista ou não a conta (não revela quem é cliente)
app.post('/auth/esqueci-senha', emailLimiter, async (req, res) => {
  const email = normalizarEmail(req.body.email);
  const resposta = { ok: true, mensagem: 'Se este e-mail tiver conta no Zevem, enviamos um link para criar uma nova senha.' };
  if (!emailValido(email)) return res.json(resposta);
  const usuario = db.prepare('SELECT id, nome, email FROM usuarios WHERE lower(trim(email)) = ?').get(email);
  if (!usuario) return res.json(resposta);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE usuarios SET reset_hash = ?, reset_expira = ? WHERE id = ?')
    .run(sha256(token).toString('hex'), Date.now() + 60 * 60 * 1000, usuario.id);
  const link = `${FRONTEND_URL}/redefinir-senha?token=${token}&email=${encodeURIComponent(usuario.email)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
      <div style="background:#05261a;border-radius:14px;padding:32px;text-align:center;">
        <div style="font-size:22px;font-weight:600;letter-spacing:-0.4px;margin-bottom:16px;">
          <span style="color:#f7f8f5;">ze</span><span style="color:#b8f15a;">vem</span></div>
        <h2 style="color:#f7f8f5;margin:0 0 8px;">Olá, ${escaparHtml(usuario.nome)}!</h2>
        <p style="color:#a8bcb0;font-size:14px;line-height:1.6;margin:0 0 24px;">
          Recebemos um pedido para criar uma nova senha. O link vale por 1 hora.<br>Se não foi você, ignore este e-mail: sua senha continua a mesma.
        </p>
        <a href="${link}" style="display:inline-block;background:#b8f15a;color:#05261a;
          padding:14px 32px;border-radius:10px;font-weight:800;text-decoration:none;font-size:14px;">
          Criar nova senha
        </a>
      </div>
    </div>`;
  try { await enviarEmail(usuario.email, 'Nova senha — Zevem', html); }
  catch (e) { console.error('[esqueci-senha] falha ao enviar:', e.message); }
  res.json(resposta);
});

// Quem abriu o link recebeu o e-mail: a conta fica confirmada e as sessões antigas caem
app.post('/auth/redefinir-senha', confirmarLimiter, async (req, res) => {
  const token = String(req.body.token || '');
  const email = normalizarEmail(req.body.email);
  const problemaSenha = erroSenha(req.body.senha);
  if (problemaSenha) return res.status(400).json({ erro: problemaSenha });
  const usuario = db.prepare('SELECT * FROM usuarios WHERE lower(trim(email)) = ?').get(email);
  const valido = usuario?.reset_hash && usuario.reset_expira > Date.now()
    && iguaisSeguro(usuario.reset_hash, sha256(token).toString('hex'));
  if (!valido) return res.status(401).json({ erro: 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".' });
  const hash = await bcrypt.hash(req.body.senha, 10);
  db.prepare(`UPDATE usuarios SET senha_hash = ?, confirmado = 1, token_confirmacao = NULL, reset_hash = NULL, reset_expira = NULL,
    sessao_versao = sessao_versao + 1 WHERE id = ?`).run(hash, usuario.id);
  const atual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario.id);
  res.json({ ok: true, token: gerarToken(atual), nome: atual.nome, email: atual.email });
});

// Troca com a senha atual: as outras sessões caem, esta recebe uma sessão nova
app.post('/auth/trocar-senha', auth(), confirmarLimiter, async (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  const atual = typeof req.body.senha_atual === 'string' ? req.body.senha_atual.slice(0, 128) : '';
  if (!(await bcrypt.compare(atual, usuario.senha_hash))) return res.status(401).json({ erro: 'Senha atual incorreta' });
  const problemaSenha = erroSenha(req.body.senha_nova);
  if (problemaSenha) return res.status(400).json({ erro: problemaSenha });
  const hash = await bcrypt.hash(req.body.senha_nova, 10);
  db.prepare('UPDATE usuarios SET senha_hash = ?, reset_hash = NULL, reset_expira = NULL, sessao_versao = sessao_versao + 1 WHERE id = ?')
    .run(hash, usuario.id);
  const novo = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(usuario.id);
  res.json({ ok: true, token: gerarToken(novo), nome: novo.nome, email: novo.email });
});

// ── LGPD: o titular baixa os próprios dados e pode excluir a conta ──
// Tabelas com usuario_id; as de cobrança ficam guardadas por obrigação fiscal (sem nome nem e-mail)
const tabelasDoUsuario = () => db.prepare(`SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
  WHERE m.type = 'table' AND p.name = 'usuario_id'`).all().map((t) => t.name);
const TABELAS_FISCAIS = ['assinaturas', 'cobrancas', 'pedidos_cancelamento'];
const CAMPOS_INTERNOS = ['senha_hash', 'token_confirmacao', 'reset_hash', 'reset_expira', 'sessao_versao', 'telefone_indice', 'telefone_codigo', 'telefone_codigo_expira'];

app.get('/conta/exportar', auth(), (req, res) => {
  const limpar = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !CAMPOS_INTERNOS.includes(k)));
  const dados = { gerado_em: new Date().toISOString(), conta: limpar(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id)) };
  for (const t of tabelasDoUsuario()) {
    dados[t] = db.prepare(`SELECT * FROM "${t}" WHERE usuario_id = ?`).all(req.user.id).map((r) => {
      const l = limpar(r);
      for (const c of ['cpf', 'email', 'telefone', 'destino']) if (typeof l[c] === 'string') l[c] = decifrar(l[c]);
      return l;
    });
  }
  res.set('Content-Disposition', 'attachment; filename="zevem-meus-dados.json"');
  res.json(dados);
});

app.post('/conta/excluir', auth(), confirmarLimiter, async (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  const senha = typeof req.body.senha === 'string' ? req.body.senha.slice(0, 128) : '';
  if (!(await bcrypt.compare(senha, usuario.senha_hash))) return res.status(401).json({ erro: 'Senha incorreta' });
  if (usuarioEhMaster(usuario.id)) return res.status(403).json({ erro: 'A conta master não pode ser excluída por aqui.' });
  if (pagamentos.temAssinatura(usuario.id)) return res.status(409).json({ erro: 'Cancele sua assinatura antes de excluir a conta.' });
  db.transaction(() => {
    for (const t of tabelasDoUsuario()) if (!TABELAS_FISCAIS.includes(t)) db.prepare(`DELETE FROM "${t}" WHERE usuario_id = ?`).run(usuario.id);
    // O registro fica só como âncora das cobranças: sem nome, e-mail nem senha que funcione
    db.prepare(`UPDATE usuarios SET nome = 'Conta excluída', email = ?, senha_hash = ?, confirmado = 0, token_confirmacao = NULL,
      reset_hash = NULL, reset_expira = NULL, sessao_versao = sessao_versao + 1 WHERE id = ?`)
      .run(`excluida-${usuario.id}@zevem.invalid`, crypto.randomBytes(32).toString('hex'), usuario.id);
  })();
  res.json({ ok: true });
});

// Derruba todas as sessões, inclusive esta
app.post('/auth/sair-todos', auth(), (req, res) => {
  db.prepare('UPDATE usuarios SET sessao_versao = sessao_versao + 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// Entrada sem senha só para desenvolvimento local: exige DEV_SEM_LOGIN=1 e requisição vinda do próprio Mac.
if (process.env.DEV_SEM_LOGIN === '1') {
  console.warn('[atenção] DEV_SEM_LOGIN ativo — /auth/dev-login entra sem senha. Nunca use em produção.');
  app.post('/auth/dev-login', (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local) return res.status(403).json({ erro: 'Disponível só localmente' });
    const usuario = db.prepare('SELECT * FROM usuarios WHERE confirmado = 1 ORDER BY id LIMIT 1').get()
      || db.prepare('SELECT * FROM usuarios ORDER BY id LIMIT 1').get();
    if (!usuario) return res.status(404).json({ erro: 'Nenhum usuário cadastrado' });
    res.json({ token: gerarToken(usuario), nome: usuario.nome, email: usuario.email });
  });
}

// ── Recebimentos ─────────────────────────────────────────────
const CLASSES_RECEBIMENTO = ['Mensal Flexível', 'Mensal Comprometido', 'Eventual Flexível', 'Eventual Comprometido'];

db.exec(`
  CREATE TABLE IF NOT EXISTS recebimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    origem TEXT NOT NULL DEFAULT '',
    classe TEXT NOT NULL DEFAULT '',
    valor REAL NOT NULL DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_recebimentos_usuario_id ON recebimentos(usuario_id)');

const REC_SELECT = `
  SELECT id, usuario_id, descricao, origem, classe, valor, criado_em,
    CASE WHEN classe LIKE 'Eventual%' THEN ROUND(valor / 12.0, 2) ELSE valor END AS valor_mensal
  FROM recebimentos
`;

function validarRecebimento(body) {
  if (body.classe && !CLASSES_RECEBIMENTO.includes(body.classe)) return 'Classe inválida';
  return null;
}

app.get('/recebimentos', auth(), (req, res) => {
  res.json(db.prepare(REC_SELECT + 'WHERE usuario_id = ? ORDER BY id').all(req.user.id));
});

app.post('/recebimentos', auth(), (req, res) => {
  const erro = validarRecebimento(req.body);
  if (erro) return res.status(400).json({ erro });
  const { descricao, origem, classe, valor } = req.body;
  const r = db.prepare(
    'INSERT INTO recebimentos (usuario_id, descricao, origem, classe, valor) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, descricao || '', origem || '', classe || '', Number(valor) || 0);
  res.status(201).json(db.prepare(REC_SELECT + 'WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/recebimentos/:id', auth(), (req, res) => {
  const erro = validarRecebimento(req.body);
  if (erro) return res.status(400).json({ erro });
  const { descricao, origem, classe, valor } = req.body;
  db.prepare(
    'UPDATE recebimentos SET descricao=?, origem=?, classe=?, valor=? WHERE id=? AND usuario_id=?'
  ).run(descricao || '', origem || '', classe || '', Number(valor) || 0, req.params.id, req.user.id);
  const rec = db.prepare(REC_SELECT + 'WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!rec) return res.status(404).json({ erro: 'Recebimento não encontrado' });
  res.json(rec);
});

app.delete('/recebimentos/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM recebimentos WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Pessoas (cadastro de membros da família) ──────────────
const RISCO_RENDA_OPCOES = ['Muito Baixo', 'Baixo', 'Mediano', 'Alto', 'Muito Alto'];
const FACILIDADE_RENDA_OPCOES = ['Muito Fácil', 'Fácil', 'Razoável', 'Difícil', 'Muito Difícil'];

db.exec(`
  CREATE TABLE IF NOT EXISTS pessoas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    data_nascimento TEXT,
    cpf TEXT,
    email TEXT,
    telefone TEXT,
    risco_renda TEXT DEFAULT '',
    facilidade_renda TEXT DEFAULT '',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_pessoas_usuario_id ON pessoas(usuario_id)');

// CPF, e-mail e telefone ficam cifrados (cripto.js). telefone_indice acha a pessoa pelo número sem abri-lo;
// telefone_verificado: a pessoa mandou pelo próprio WhatsApp o código gerado no app (só então o número vale).
try { db.prepare('ALTER TABLE pessoas ADD COLUMN telefone_indice TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE pessoas ADD COLUMN telefone_verificado INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE pessoas ADD COLUMN telefone_codigo TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE pessoas ADD COLUMN telefone_codigo_expira INTEGER').run(); } catch {}
db.exec('CREATE INDEX IF NOT EXISTS idx_pessoas_telefone_indice ON pessoas(telefone_indice)');
// Cifra o que ainda estiver em texto puro (cadastros antigos)
db.transaction(() => {
  const gravar = db.prepare('UPDATE pessoas SET cpf = ?, email = ?, telefone = ?, telefone_indice = ? WHERE id = ?');
  for (const p of db.prepare("SELECT id, cpf, email, telefone FROM pessoas WHERE COALESCE(cpf, '') NOT LIKE 'enc:%' OR COALESCE(email, '') NOT LIKE 'enc:%' OR COALESCE(telefone, '') NOT LIKE 'enc:%'").all()) {
    const tel = decifrar(p.telefone);
    gravar.run(cifrar(decifrar(p.cpf)), cifrar(decifrar(p.email)), cifrar(tel), indice(chaveTelefone(tel)), p.id);
  }
})();

const PESSOA_SELECT = 'SELECT id, usuario_id, nome, data_nascimento, cpf, email, telefone, risco_renda, facilidade_renda, telefone_verificado, criado_em FROM pessoas ';
const pessoaAberta = (p) => p && { ...p, cpf: decifrar(p.cpf), email: decifrar(p.email), telefone: decifrar(p.telefone), telefone_verificado: !!p.telefone_verificado };
const textoCampo = (v, max) => String(v ?? '').trim().slice(0, max);

function validarPessoa(body) {
  const { nome, risco_renda, facilidade_renda } = body;
  if (!String(nome ?? '').trim()) return 'Nome é obrigatório';
  if (String(nome).length > 100) return 'Nome longo demais';
  if (body.data_nascimento && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.data_nascimento))) return 'Data de nascimento inválida';
  if (risco_renda && !RISCO_RENDA_OPCOES.includes(risco_renda)) return 'Grau de risco de renda inválido';
  if (facilidade_renda && !FACILIDADE_RENDA_OPCOES.includes(facilidade_renda)) return 'Facilidade de renda inválida';
  return null;
}

// O telefone identifica quem manda mensagem pelo WhatsApp: um número confirmado não entra em outra conta
function telefoneEmOutraConta(telefone, usuarioId) {
  const chave = chaveTelefone(telefone);
  return !!chave && !!db.prepare('SELECT 1 FROM pessoas WHERE telefone_indice = ? AND telefone_verificado = 1 AND usuario_id <> ?')
    .get(indice(chave), usuarioId);
}
const ERRO_TELEFONE = 'Este telefone já está cadastrado em outra conta do Zevem. Cada número do WhatsApp só pode estar ligado a uma conta.';

app.get('/pessoas', auth(), (req, res) => {
  res.json(db.prepare(PESSOA_SELECT + 'WHERE usuario_id = ? ORDER BY id').all(req.user.id).map(pessoaAberta));
});

const LIMITE_PESSOAS = 2;

app.post('/pessoas', auth(), (req, res) => {
  const erro = validarPessoa(req.body);
  if (erro) return res.status(400).json({ erro });
  if (telefoneEmOutraConta(req.body.telefone, req.user.id)) return res.status(409).json({ erro: ERRO_TELEFONE });
  const total = db.prepare('SELECT COUNT(*) AS c FROM pessoas WHERE usuario_id = ?').get(req.user.id).c;
  if (total >= LIMITE_PESSOAS) {
    return res.status(400).json({ erro: `Limite de ${LIMITE_PESSOAS} pessoas cadastradas atingido.` });
  }
  const { data_nascimento, risco_renda, facilidade_renda } = req.body;
  const telefone = textoCampo(req.body.telefone, 30);
  const r = db.prepare(`
    INSERT INTO pessoas (usuario_id, nome, data_nascimento, cpf, email, telefone, telefone_indice, risco_renda, facilidade_renda)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, textoCampo(req.body.nome, 100), data_nascimento || null, cifrar(textoCampo(req.body.cpf, 20)), cifrar(textoCampo(req.body.email, 254)),
    cifrar(telefone), indice(chaveTelefone(telefone)), risco_renda || '', facilidade_renda || '');
  res.status(201).json(pessoaAberta(db.prepare(PESSOA_SELECT + 'WHERE id = ?').get(r.lastInsertRowid)));
});

app.put('/pessoas/:id', auth(), (req, res) => {
  const erro = validarPessoa(req.body);
  if (erro) return res.status(400).json({ erro });
  if (telefoneEmOutraConta(req.body.telefone, req.user.id)) return res.status(409).json({ erro: ERRO_TELEFONE });
  const { data_nascimento, risco_renda, facilidade_renda } = req.body;
  const atual = db.prepare('SELECT telefone_indice FROM pessoas WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!atual) return res.status(404).json({ erro: 'Pessoa não encontrada' });
  const telefone = textoCampo(req.body.telefone, 30);
  const novoIndice = indice(chaveTelefone(telefone));
  // Número trocado: precisa ser confirmado de novo
  const mesmoNumero = novoIndice && novoIndice === atual.telefone_indice;
  db.prepare(`
    UPDATE pessoas SET nome=?, data_nascimento=?, cpf=?, email=?, telefone=?, telefone_indice=?, risco_renda=?, facilidade_renda=?,
      telefone_verificado = CASE WHEN ? THEN telefone_verificado ELSE 0 END,
      telefone_codigo = CASE WHEN ? THEN telefone_codigo END, telefone_codigo_expira = CASE WHEN ? THEN telefone_codigo_expira END
    WHERE id=? AND usuario_id=?
  `).run(textoCampo(req.body.nome, 100), data_nascimento || null, cifrar(textoCampo(req.body.cpf, 20)), cifrar(textoCampo(req.body.email, 254)),
    cifrar(telefone), novoIndice, risco_renda || '', facilidade_renda || '', mesmoNumero ? 1 : 0, mesmoNumero ? 1 : 0, mesmoNumero ? 1 : 0,
    req.params.id, req.user.id);
  res.json(pessoaAberta(db.prepare(PESSOA_SELECT + 'WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id)));
});

// Código para confirmar o WhatsApp: a pessoa manda "ZEVEM 123456" do próprio número para o Zevem (vale 30 min)
app.post('/pessoas/:id/telefone/codigo', auth(), confirmarLimiter, (req, res) => {
  const p = db.prepare('SELECT telefone, telefone_verificado FROM pessoas WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ erro: 'Pessoa não encontrada' });
  if (!chaveTelefone(decifrar(p.telefone))) return res.status(400).json({ erro: 'Cadastre um celular com DDD antes de confirmar.' });
  if (p.telefone_verificado) return res.json({ ok: true, ja_confirmado: true });
  if (telefoneEmOutraConta(decifrar(p.telefone), req.user.id)) return res.status(409).json({ erro: ERRO_TELEFONE });
  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('UPDATE pessoas SET telefone_codigo = ?, telefone_codigo_expira = ? WHERE id = ?')
    .run(sha256(codigo).toString('hex'), Date.now() + 30 * 60 * 1000, req.params.id);
  const numero = String(process.env.WHATSAPP_NUMERO || '').replace(/\D/g, '');
  res.json({ ok: true, codigo, mensagem: `ZEVEM ${codigo}`, numero_zevem: numero || null,
    link: numero ? `https://wa.me/${numero}?text=${encodeURIComponent(`ZEVEM ${codigo}`)}` : null });
});

// Excluir uma pessoa apaga a categoria de gastos dela ("pessoa-1" ou "pessoa-2", pela ordem de cadastro)
// com todos os itens e lançamentos. Se sair a primeira, a categoria da segunda passa a ser "pessoa-1",
// para continuar ligada a ela.
app.delete('/pessoas/:id', auth(), (req, res) => {
  const pessoas = db.prepare('SELECT id FROM pessoas WHERE usuario_id = ? ORDER BY id').all(req.user.id);
  const posicao = pessoas.findIndex((p) => String(p.id) === String(req.params.id));
  if (posicao < 0) return res.json({ ok: true, itens_removidos: 0 });
  const categoria = `pessoa-${posicao + 1}`;
  const removidos = db.transaction(() => {
    const ids = db.prepare('SELECT id FROM gastos WHERE usuario_id = ? AND categoria = ?').all(req.user.id, categoria).map((g) => g.id);
    for (const id of ids) {
      db.prepare('DELETE FROM lancamentos_gastos WHERE gasto_id = ? AND usuario_id = ?').run(id, req.user.id);
      db.prepare('DELETE FROM gastos_aprendizado WHERE gasto_id = ? AND usuario_id = ?').run(id, req.user.id);
      db.prepare('UPDATE gastos_suspensos SET gasto_sugerido_id = NULL WHERE gasto_sugerido_id = ? AND usuario_id = ?').run(id, req.user.id);
    }
    db.prepare('DELETE FROM gastos WHERE usuario_id = ? AND categoria = ?').run(req.user.id, categoria);
    if (posicao === 0 && pessoas.length > 1) {
      db.prepare("UPDATE gastos SET categoria = 'pessoa-1' WHERE usuario_id = ? AND categoria = 'pessoa-2'").run(req.user.id);
    }
    db.prepare('DELETE FROM pessoas WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
    return ids.length;
  })();
  res.json({ ok: true, itens_removidos: removidos });
});

// ── Cartões ────────────────────────────────────────────────
const BANCOS_OPCOES = ['itau', 'bb', 'caixa', 'santander', 'bradesco', 'nubank', 'inter', 'porto', 'sicoob', 'outros'];

db.exec(`
  CREATE TABLE IF NOT EXISTS cartoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    ultimos_digitos TEXT DEFAULT '',
    banco TEXT DEFAULT '',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_cartoes_usuario_id ON cartoes(usuario_id)');
// Dias da fatura (1 a 31): base dos avisos de fechamento/vencimento e do melhor dia de compra
try { db.prepare('ALTER TABLE cartoes ADD COLUMN dia_fechamento INTEGER').run(); } catch {}
try { db.prepare('ALTER TABLE cartoes ADD COLUMN dia_vencimento INTEGER').run(); } catch {}

// Dia do mês opcional: vazio vira null; fora de 1..31 é inválido (undefined)
function diaDoMes(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : undefined;
}

function validarCartao(body) {
  if (!body.nome) return 'Nome do cartão é obrigatório';
  if (diaDoMes(body.dia_fechamento) === undefined) return 'Dia de fechamento inválido (1 a 31)';
  if (diaDoMes(body.dia_vencimento) === undefined) return 'Dia de vencimento inválido (1 a 31)';
  if (body.ultimos_digitos && !/^\d{4}$/.test(body.ultimos_digitos)) return 'Informe exatamente 4 dígitos';
  if (body.banco && !BANCOS_OPCOES.includes(body.banco)) return 'Banco inválido';
  return null;
}

app.get('/cartoes', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM cartoes WHERE usuario_id = ? ORDER BY id').all(req.user.id));
});

app.post('/cartoes', auth(), (req, res) => {
  const erro = validarCartao(req.body);
  if (erro) return res.status(400).json({ erro });
  const { nome, ultimos_digitos, banco, dia_fechamento, dia_vencimento } = req.body;
  const r = db.prepare('INSERT INTO cartoes (usuario_id, nome, ultimos_digitos, banco, dia_fechamento, dia_vencimento) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, nome, ultimos_digitos || '', banco || '', diaDoMes(dia_fechamento), diaDoMes(dia_vencimento));
  res.status(201).json(db.prepare('SELECT * FROM cartoes WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/cartoes/:id', auth(), (req, res) => {
  const erro = validarCartao(req.body);
  if (erro) return res.status(400).json({ erro });
  const { nome, ultimos_digitos, banco, dia_fechamento, dia_vencimento } = req.body;
  db.prepare('UPDATE cartoes SET nome = ?, ultimos_digitos = ?, banco = ?, dia_fechamento = ?, dia_vencimento = ? WHERE id = ? AND usuario_id = ?')
    .run(nome, ultimos_digitos || '', banco || '', diaDoMes(dia_fechamento), diaDoMes(dia_vencimento), req.params.id, req.user.id);
  const cartao = db.prepare('SELECT * FROM cartoes WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!cartao) return res.status(404).json({ erro: 'Cartão não encontrado' });
  res.json(cartao);
});

app.delete('/cartoes/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM cartoes WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Gastos ─────────────────────────────────────────────────
const CLASSES_GASTO = ['Mensal Flexível', 'Mensal Comprometido', 'Eventual Flexível', 'Eventual Comprometido'];

db.exec(`
  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    categoria TEXT NOT NULL DEFAULT '',
    descricao TEXT NOT NULL DEFAULT '',
    com_cartao INTEGER NOT NULL DEFAULT 0,
    classe TEXT NOT NULL DEFAULT '',
    valor REAL NOT NULL DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_gastos_usuario_id ON gastos(usuario_id)');

const GASTOS_DEFAULT = [
  // MORADIA
  { categoria: 'moradia', descricao: 'Condomínio', classe: 'Mensal Comprometido' },
  { categoria: 'moradia', descricao: 'Móveis / Decoração / Manutenção', classe: 'Eventual Flexível' },
  { categoria: 'moradia', descricao: 'Água', classe: 'Mensal Comprometido' },
  { categoria: 'moradia', descricao: 'IPTU / Obrigações Legais', classe: 'Eventual Comprometido' },
  { categoria: 'moradia', descricao: 'Aluguel', classe: 'Mensal Comprometido' },
  { categoria: 'moradia', descricao: 'Gás', classe: 'Eventual Flexível' },
  { categoria: 'moradia', descricao: 'Empregados Diaristas (Diarista/Piscineiro/Jardineiro/Etc)', classe: 'Mensal Flexível' },
  { categoria: 'moradia', descricao: 'Animais de Estimação', classe: 'Mensal Flexível' },
  { categoria: 'moradia', descricao: 'Luz', classe: 'Mensal Comprometido' },
  { categoria: 'moradia', descricao: 'Empregados Mensalistas', classe: 'Mensal Comprometido' },
  { categoria: 'moradia', descricao: 'Telefone / Internet', classe: 'Mensal Comprometido' },
  { categoria: 'moradia', descricao: 'Supermercado / Feira / Açougue', classe: 'Mensal Flexível' },
  // TRANSPORTE
  { categoria: 'transporte', descricao: 'Uber / Taxi / 99Pop', classe: 'Mensal Flexível' },
  { categoria: 'transporte', descricao: 'Estacionamento / Pedágio / Sem Parar', classe: 'Mensal Flexível' },
  { categoria: 'transporte', descricao: 'IPVA / Licenciamento / Despesas Legais', classe: 'Eventual Comprometido' },
  { categoria: 'transporte', descricao: 'Lavagem', classe: 'Mensal Flexível' },
  { categoria: 'transporte', descricao: 'Revisão / Manutenção', classe: 'Eventual Flexível' },
  { categoria: 'transporte', descricao: 'Seguro do Veículo', classe: 'Eventual Comprometido' },
  { categoria: 'transporte', descricao: 'Combustível', classe: 'Mensal Flexível' },
  // VIDA E SAÚDE
  { categoria: 'vida-saude', descricao: 'Plano Odontológico', classe: 'Mensal Comprometido' },
  { categoria: 'vida-saude', descricao: 'Plano de Saúde', classe: 'Mensal Comprometido' },
  { categoria: 'vida-saude', descricao: 'Tratamentos / Terapias mensais', classe: 'Mensal Flexível' },
  { categoria: 'vida-saude', descricao: 'Farmácia / Medicamentos', classe: 'Mensal Flexível' },
  { categoria: 'vida-saude', descricao: 'Seguro de Vida', classe: 'Mensal Comprometido' },
  { categoria: 'vida-saude', descricao: 'Planejamento Financeiro', classe: 'Mensal Comprometido' },
  { categoria: 'vida-saude', descricao: 'Suplementos', classe: 'Mensal Flexível' },
  { categoria: 'vida-saude', descricao: 'Consultas / Exames Anuais', classe: 'Eventual Flexível' },
  { categoria: 'vida-saude', descricao: 'Dentista / Ortodontia', classe: 'Eventual Flexível' },
  { categoria: 'vida-saude', descricao: 'Óculos / Lentes', classe: 'Eventual Flexível' },
  // LAZER E DOAÇÕES
  { categoria: 'lazer-doacoes', descricao: 'Passeios / Lazer Anual (Shows/Teatro/Cinema/Eventos)', classe: 'Eventual Flexível' },
  { categoria: 'lazer-doacoes', descricao: 'Viagens Curtas', classe: 'Eventual Flexível' },
  { categoria: 'lazer-doacoes', descricao: 'Lazer Mensal (Bares/Restaurantes/Baladas)', classe: 'Mensal Flexível' },
  { categoria: 'lazer-doacoes', descricao: 'Presentes Dados aos Outros', classe: 'Eventual Flexível' },
  { categoria: 'lazer-doacoes', descricao: 'Ofertas / Doações / Dízimos', classe: 'Eventual Flexível' },
  { categoria: 'lazer-doacoes', descricao: 'Festas e Datas Comemorativas (Natal, aniversários)', classe: 'Eventual Flexível' },
  // ALIMENTAÇÃO FDC
  { categoria: 'alimentacao', descricao: 'Almoço / Lanches / Jantar', classe: 'Mensal Flexível' },
  { categoria: 'alimentacao', descricao: 'Delivery (iFood, etc.)', classe: 'Mensal Flexível' },
  // ASSINATURAS
  { categoria: 'assinaturas', descricao: 'Spotify', classe: 'Mensal Comprometido' },
  { categoria: 'assinaturas', descricao: 'Netflix', classe: 'Mensal Comprometido' },
  { categoria: 'assinaturas', descricao: 'Youtube', classe: 'Mensal Comprometido' },
  { categoria: 'assinaturas', descricao: 'HBO', classe: 'Mensal Comprometido' },
  { categoria: 'assinaturas', descricao: 'Amazon Prime', classe: 'Mensal Comprometido' },
  // DESPESAS PESSOAIS - PESSOA 1
  { categoria: 'pessoa-1', descricao: 'Academia / Esportes', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-1', descricao: 'Hobby Pessoal', classe: 'Mensal Flexível' },
  { categoria: 'pessoa-1', descricao: 'Tarifas Bancárias', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-1', descricao: 'Perfumes / Cosméticos', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-1', descricao: 'Cursos / Livros / Palestras / Papelaria', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-1', descricao: 'Vestuário e Acessórios', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-1', descricao: 'Barbearia', classe: 'Mensal Flexível' },
  { categoria: 'pessoa-1', descricao: 'Tratamentos Estéticos', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-1', descricao: 'Conta de Celular', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-1', descricao: 'Salão Anual (Cabelo)', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-1', descricao: 'Salão Mensal (Manicure / Sobrancelha / Depilação)', classe: 'Mensal Flexível' },
  { categoria: 'pessoa-1', descricao: 'Troca de Celular / Itens Eletrônicos', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-1', descricao: 'Educação Mensal', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-1', descricao: 'Anuidade de Cartão', classe: 'Eventual Comprometido' },
  // DESPESAS PESSOAIS - PESSOA 2
  { categoria: 'pessoa-2', descricao: 'Academia / Esportes', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-2', descricao: 'Hobby Pessoal', classe: 'Mensal Flexível' },
  { categoria: 'pessoa-2', descricao: 'Tarifas Bancárias', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-2', descricao: 'Perfumes / Cosméticos', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-2', descricao: 'Cursos / Livros / Palestras / Papelaria', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-2', descricao: 'Vestuário e Acessórios', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-2', descricao: 'Barbearia', classe: 'Mensal Flexível' },
  { categoria: 'pessoa-2', descricao: 'Tratamentos Estéticos', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-2', descricao: 'Conta de Celular', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-2', descricao: 'Salão Anual (Cabelo)', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-2', descricao: 'Salão Mensal (Manicure / Sobrancelha / Depilação)', classe: 'Mensal Flexível' },
  { categoria: 'pessoa-2', descricao: 'Troca de Celular / Itens Eletrônicos', classe: 'Eventual Flexível' },
  { categoria: 'pessoa-2', descricao: 'Educação Mensal', classe: 'Mensal Comprometido' },
  { categoria: 'pessoa-2', descricao: 'Anuidade de Cartão', classe: 'Eventual Comprometido' },
  // DEPENDENTES — de bebê a adolescente. Saúde (dentista, óculos, consultas), festas, lanches fora e
  // streaming ficam nas categorias da família (Vida e Saúde, Lazer, Alimentação FDC, Assinaturas).
  { categoria: 'dependentes', descricao: 'Escola / Mensalidade', classe: 'Mensal Comprometido' },
  { categoria: 'dependentes', descricao: 'Material Escolar e Uniforme', classe: 'Eventual Comprometido' },
  { categoria: 'dependentes', descricao: 'Transporte Escolar', classe: 'Mensal Comprometido' },
  { categoria: 'dependentes', descricao: 'Babá / Creche', classe: 'Mensal Comprometido' },
  { categoria: 'dependentes', descricao: 'Fraldas / Higiene Infantil', classe: 'Mensal Flexível' },
  { categoria: 'dependentes', descricao: 'Cursos Extracurriculares (Idiomas / Música / Reforço)', classe: 'Mensal Flexível' },
  { categoria: 'dependentes', descricao: 'Cursinho / Pré-Vestibular', classe: 'Mensal Comprometido' },
  { categoria: 'dependentes', descricao: 'Academia / Esportes', classe: 'Mensal Comprometido' },
  { categoria: 'dependentes', descricao: 'Vestuário e Calçados', classe: 'Eventual Flexível' },
  { categoria: 'dependentes', descricao: 'Cuidados Pessoais (Salão / Barbearia / Cosméticos)', classe: 'Mensal Flexível' },
  { categoria: 'dependentes', descricao: 'Brinquedos / Jogos / Games', classe: 'Eventual Flexível' },
  { categoria: 'dependentes', descricao: 'Mesada', classe: 'Mensal Flexível' },
  { categoria: 'dependentes', descricao: 'Conta de Celular', classe: 'Mensal Comprometido' },
  { categoria: 'dependentes', descricao: 'Troca de Celular / Itens Eletrônicos', classe: 'Eventual Flexível' },
  { categoria: 'dependentes', descricao: 'Excursões / Viagens Escolares', classe: 'Eventual Flexível' },
  { categoria: 'dependentes', descricao: 'Autoescola / CNH', classe: 'Eventual Flexível' },
  // EMPRESA
  { categoria: 'empresa', descricao: 'Impostos Mensais', classe: 'Mensal Comprometido' },
  { categoria: 'empresa', descricao: 'Contador', classe: 'Mensal Comprometido' },
  { categoria: 'empresa', descricao: 'Folha de Pagamento', classe: 'Mensal Comprometido' },
  { categoria: 'empresa', descricao: 'Materiais Escritório', classe: 'Mensal Flexível' },
  { categoria: 'empresa', descricao: 'Sistemas e Aplicativos', classe: 'Mensal Comprometido' },
  { categoria: 'empresa', descricao: 'Licenças', classe: 'Mensal Comprometido' },
  { categoria: 'empresa', descricao: 'Insumos', classe: 'Mensal Flexível' },
];

function seedGastosDefault(usuarioId) {
  const insert = db.prepare(
    'INSERT INTO gastos (usuario_id, categoria, descricao, com_cartao, classe, valor) VALUES (?, ?, ?, 0, ?, 0)'
  );
  const seedAll = db.transaction(() => {
    for (const g of GASTOS_DEFAULT) {
      insert.run(usuarioId, g.categoria, g.descricao, g.classe);
    }
  });
  seedAll();
}

// meta_desde (AAAA-MM-01): mês em que o item passou a ter meta. Nos eventuais, o disponível cresce 1/12
// da meta por mês a partir daí, até 1 meta anual (janela móvel de 12 meses).
try { db.prepare('ALTER TABLE gastos ADD COLUMN meta_desde TEXT').run(); } catch {}
// Itens que já tinham meta: sem histórico, conta a partir da criação do item.
db.exec("UPDATE gastos SET meta_desde = substr(criado_em, 1, 7) || '-01' WHERE valor > 0 AND meta_desde IS NULL");
const mesAtualIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

// Vencimento das contas com data fixa: Mensal Comprometido usa o dia do mês; Eventual Comprometido,
// que vence uma vez por ano, usa só o mês. Gasto pago no cartão vence com a fatura (sem data própria).
try { db.prepare('ALTER TABLE gastos ADD COLUMN dia_vencimento INTEGER').run(); } catch {}
try { db.prepare('ALTER TABLE gastos ADD COLUMN mes_vencimento INTEGER').run(); } catch {}

const GASTO_SELECT = `
  SELECT id, usuario_id, categoria, descricao, com_cartao, classe, valor, criado_em, meta_desde, dia_vencimento, mes_vencimento,
    CASE WHEN classe LIKE 'Eventual%' THEN ROUND(valor / 12.0, 0) ELSE valor END AS valor_mensal
  FROM gastos
`;

// ── Categoria fixa "Não Identificado" ──
// Existe em todo orçamento, com um único item de mesmo nome. Não pode ser editada nem apagada, não
// aceita itens novos e só recebe lançamentos classificados manualmente: fica fora das regras,
// do aprendizado e das sugestões automáticas.
const CATEGORIA_NI = 'nao-identificado';
const NOME_NI = 'Não Identificado';

function garantirNaoIdentificado(usuarioId) {
  const atual = db.prepare('SELECT id FROM gastos WHERE usuario_id = ? AND categoria = ? ORDER BY id LIMIT 1').get(usuarioId, CATEGORIA_NI);
  if (atual) return atual.id;
  return db.prepare("INSERT INTO gastos (usuario_id, categoria, descricao, com_cartao, classe, valor) VALUES (?, ?, ?, 0, '', 0)")
    .run(usuarioId, CATEGORIA_NI, NOME_NI).lastInsertRowid;
}

const ehNaoIdentificado = (usuarioId, gastoId) =>
  !!gastoId && !!db.prepare('SELECT 1 FROM gastos WHERE id = ? AND usuario_id = ? AND categoria = ?').get(gastoId, usuarioId, CATEGORIA_NI);

// Usuários que já existiam ganham a categoria ao subir o servidor.
db.transaction(() => {
  for (const u of db.prepare("SELECT id FROM usuarios WHERE email NOT LIKE '%@zevem.invalid'").all()) garantirNaoIdentificado(u.id); // sem as contas excluídas
})();

// Categorias que aceitam itens (nao-identificado é fixa; pessoa-1/2 são as abas de cada adulto)
const CATEGORIAS_GASTO = ['moradia', 'transporte', 'vida-saude', 'lazer-doacoes', 'alimentacao', 'assinaturas',
  'pessoa-1', 'pessoa-2', 'dependentes', 'empresa'];

function validarGasto(body) {
  if (String(body.descricao ?? '').length > 120) return 'Nome do item longo demais (até 120 caracteres)';
  if (!Number.isFinite(Number(body.valor ?? 0)) || Number(body.valor) < 0 || Number(body.valor) > 1e9) return 'Valor inválido';
  if (body.classe && !CLASSES_GASTO.includes(body.classe)) return 'Classe inválida';
  if (diaDoMes(body.dia_vencimento) === undefined) return 'Dia de vencimento inválido (1 a 31)';
  const mes = body.mes_vencimento;
  if (!(mes === null || mes === undefined || mes === '') && !(Number.isInteger(Number(mes)) && mes >= 1 && mes <= 12)) return 'Mês de vencimento inválido (1 a 12)';
  return null;
}

// Só guarda vencimento fora do cartão: dia na Mensal Comprometido, mês na Eventual Comprometido
function vencimentoGasto(body) {
  if (body.com_cartao) return { dia: null, mes: null };
  if (body.classe === 'Mensal Comprometido') return { dia: diaDoMes(body.dia_vencimento), mes: null };
  if (body.classe === 'Eventual Comprometido') return { dia: null, mes: body.mes_vencimento ? Number(body.mes_vencimento) : null };
  return { dia: null, mes: null };
}

app.get('/gastos', auth(), (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM gastos WHERE usuario_id = ? AND categoria <> ?').get(req.user.id, CATEGORIA_NI).n;
  if (total === 0) seedGastosDefault(req.user.id);
  garantirNaoIdentificado(req.user.id);
  const { categoria } = req.query;
  const rows = categoria
    ? db.prepare(GASTO_SELECT + 'WHERE usuario_id = ? AND categoria = ? ORDER BY id').all(req.user.id, categoria)
    : db.prepare(GASTO_SELECT + 'WHERE usuario_id = ? ORDER BY id').all(req.user.id);
  res.json(rows);
});

app.post('/gastos', auth(), (req, res) => {
  const erro = validarGasto(req.body);
  if (erro) return res.status(400).json({ erro });
  const { categoria, descricao, com_cartao, classe, valor } = req.body;
  if (categoria === CATEGORIA_NI) return res.status(403).json({ erro: `A categoria "${NOME_NI}" é fixa e não aceita itens novos.` });
  if (!CATEGORIAS_GASTO.includes(categoria)) return res.status(400).json({ erro: 'Categoria inválida' });
  // Item com nome igual na mesma categoria: devolve o existente (409) em vez de duplicar.
  const nome = String(descricao || '').trim();
  if (nome) {
    const chave = normalizarTexto(nome).replace(/\s+/g, ' ');
    const existente = db.prepare(GASTO_SELECT + "WHERE usuario_id = ? AND categoria = ? AND TRIM(descricao) <> ''").all(req.user.id, categoria || '')
      .find((g) => normalizarTexto(g.descricao.trim()).replace(/\s+/g, ' ') === chave);
    if (existente) return res.status(409).json({ erro: `Já existe "${existente.descricao}" nesta categoria.`, gasto: existente });
  }
  const r = db.prepare(
    'INSERT INTO gastos (usuario_id, categoria, descricao, com_cartao, classe, valor, meta_desde) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, categoria || '', descricao || '', com_cartao ? 1 : 0, classe || '', Number(valor) || 0,
    Number(valor) > 0 ? mesAtualIso() : null);
  res.status(201).json(db.prepare(GASTO_SELECT + 'WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/gastos/:id', auth(), (req, res) => {
  const erro = validarGasto(req.body);
  if (erro) return res.status(400).json({ erro });
  if (ehNaoIdentificado(req.user.id, req.params.id)) return res.status(403).json({ erro: `O item "${NOME_NI}" é fixo e não pode ser editado.` });
  const { descricao, com_cartao, classe, valor } = req.body;
  const atual = db.prepare('SELECT valor, meta_desde, dia_vencimento, mes_vencimento FROM gastos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  // Quem não manda os campos de vencimento (ex.: edição só da meta) mantém o que já está gravado
  const semVencimento = !('dia_vencimento' in req.body) && !('mes_vencimento' in req.body);
  const venc = vencimentoGasto(semVencimento && atual ? { ...req.body, dia_vencimento: atual.dia_vencimento, mes_vencimento: atual.mes_vencimento } : req.body);
  const novoValor = Number(valor) || 0;
  // A meta passa a contar no mês em que deixa de ser zero; zerada, deixa de contar.
  const metaDesde = novoValor > 0 ? (atual?.valor > 0 && atual.meta_desde ? atual.meta_desde : mesAtualIso()) : null;
  db.prepare(
    'UPDATE gastos SET descricao=?, com_cartao=?, classe=?, valor=?, meta_desde=?, dia_vencimento=?, mes_vencimento=? WHERE id=? AND usuario_id=?'
  ).run(descricao || '', com_cartao ? 1 : 0, classe || '', novoValor, metaDesde, venc.dia, venc.mes, req.params.id, req.user.id);
  const gasto = db.prepare(GASTO_SELECT + 'WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!gasto) return res.status(404).json({ erro: 'Item não encontrado' });
  res.json(gasto);
});

app.delete('/gastos/:id', auth(), (req, res) => {
  if (ehNaoIdentificado(req.user.id, req.params.id)) return res.status(403).json({ erro: `O item "${NOME_NI}" é fixo e não pode ser apagado.` });
  db.prepare('DELETE FROM lancamentos_gastos WHERE gasto_id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  db.prepare('DELETE FROM gastos_aprendizado WHERE gasto_id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  db.prepare('UPDATE gastos_suspensos SET gasto_sugerido_id = NULL WHERE gasto_sugerido_id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  db.prepare('DELETE FROM gastos WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Gestão de Gastos (realizado mês a mês) ────────────────────
// Cada lançamento é um gasto efetivo ligado a um item planejado. A meta mensal do item é o
// valor_mensal de /gastos. `origem` distingue o que veio do WhatsApp do que foi lançado na tela.
db.exec(`
  CREATE TABLE IF NOT EXISTS lancamentos_gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    gasto_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    valor REAL NOT NULL,
    descricao TEXT DEFAULT '',
    origem TEXT NOT NULL DEFAULT 'manual',
    criado_em TEXT DEFAULT (datetime('now'))
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_lancamentos_usuario_data ON lancamentos_gastos(usuario_id, data)');
// Lançamentos criados juntos por uma recorrência compartilham o mesmo grupo.
try { db.prepare('ALTER TABLE lancamentos_gastos ADD COLUMN recorrencia_grupo TEXT').run(); } catch {}
// Número da parcela (x) e total de parcelas (y) de um recorrente/parcelado, gravados na criação.
try { db.prepare('ALTER TABLE lancamentos_gastos ADD COLUMN parcela INTEGER').run(); } catch {}
try { db.prepare('ALTER TABLE lancamentos_gastos ADD COLUMN total_parcelas INTEGER').run(); } catch {}
// Tipo da série: 'parcelado' (uma compra dividida — nos eventuais conta o valor total no mês da compra)
// ou 'recorrencia' (o mesmo gasto todo mês). Séries antigas: fatura e itens eventuais = parcelado.
try { db.prepare('ALTER TABLE lancamentos_gastos ADD COLUMN repeticao TEXT').run(); } catch {}
db.exec(`
  UPDATE lancamentos_gastos SET repeticao = CASE
    WHEN origem = 'fatura' THEN 'parcelado'
    WHEN (SELECT classe FROM gastos g WHERE g.id = lancamentos_gastos.gasto_id) LIKE 'Eventual%' THEN 'parcelado'
    ELSE 'recorrencia' END
  WHERE recorrencia_grupo IS NOT NULL AND repeticao IS NULL
`);
// Recorrências criadas antes dessas colunas: numera pela ordem das datas dentro do grupo.
db.exec(`
  UPDATE lancamentos_gastos SET
    parcela = (SELECT COUNT(*) FROM lancamentos_gastos o
               WHERE o.recorrencia_grupo = lancamentos_gastos.recorrencia_grupo
                 AND (o.data < lancamentos_gastos.data OR (o.data = lancamentos_gastos.data AND o.id <= lancamentos_gastos.id))),
    total_parcelas = (SELECT COUNT(*) FROM lancamentos_gastos o WHERE o.recorrencia_grupo = lancamentos_gastos.recorrencia_grupo)
  WHERE recorrencia_grupo IS NOT NULL AND parcela IS NULL
`);

// Soma `n` meses a uma data AAAA-MM-DD, mantendo o dia (ou o último dia do mês, se não existir).
function somarMeses(data, n) {
  const [a, m, d] = data.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

const ORIGENS_LANCAMENTO = ['manual', 'whatsapp', 'fatura'];

// Divide `total` em `n` parcelas, em centavos; as primeiras levam a sobra (mesma regra da tela).
function dividirEmParcelas(total, n) {
  const centavos = Math.round(total * 100);
  const base = Math.floor(centavos / n);
  const sobra = centavos - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < sobra ? 1 : 0)) / 100);
}

// Quanto saiu por mês em cada item eventual, em todos os anos (cada parcela no seu mês). A tela usa
// para a regra do limite anual: nenhum período de 12 meses consecutivos pode passar da meta anual.
function mensalEventuais(usuarioId) {
  return db.prepare(`
    SELECT l.gasto_id, substr(l.data, 1, 7) AS mes, ROUND(SUM(l.valor), 2) AS total
    FROM lancamentos_gastos l JOIN gastos g ON g.id = l.gasto_id
    WHERE l.usuario_id = ? AND g.classe LIKE 'Eventual%'
    GROUP BY l.gasto_id, mes
  `).all(usuarioId);
}

// Realizado por item e mês numa faixa (de/ate = AAAA-MM, pode atravessar anos) ou num ano inteiro.
// Cada linha traz `chave` (AAAA-MM); `mes` (1–12) segue para compatibilidade.
app.get('/gestao-gastos', auth(), (req, res) => {
  const ano = /^\d{4}$/.test(String(req.query.ano || '')) ? String(req.query.ano) : String(new Date().getFullYear());
  const mesValido = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));
  const de = mesValido(req.query.de) ? String(req.query.de) : `${ano}-01`;
  const ate = mesValido(req.query.ate) ? String(req.query.ate) : `${ano}-12`;
  garantirNaoIdentificado(req.user.id);
  const itens = db.prepare(GASTO_SELECT + 'WHERE usuario_id = ? ORDER BY id').all(req.user.id);
  const realizados = db.prepare(`
    SELECT gasto_id, substr(data, 1, 7) AS chave, CAST(substr(data, 6, 2) AS INTEGER) AS mes, SUM(valor) AS total, COUNT(*) AS quantidade
    FROM lancamentos_gastos
    WHERE usuario_id = ? AND substr(data, 1, 7) BETWEEN ? AND ?
    GROUP BY gasto_id, chave
  `).all(req.user.id, de, ate);
  res.json({ ano: Number(ano), itens, realizados, mensal_eventuais: mensalEventuais(req.user.id), ...dadosPagamentos(req.user.id, de, ate) });
});

// Sugestão automática de metas (só calcula; quem aplica é a tela, item a item, pelo PUT /gastos/:id).
// Usa só meses fechados (o mês atual ainda está em andamento).
//   Mensais:   média dos últimos 3 meses fechados, ignorando os meses sem gasto.
//   Eventuais: projeção do consumo atual para 12 meses = média mensal do período observado × 12.
//              Período observado: últimos 12 meses fechados, a partir do primeiro lançamento do usuário.
// Item sem gasto no período fica de fora (a meta atual é mantida).
app.get('/gestao-gastos/sugestao-metas', auth(), (req, res) => {
  const [ano, mes] = agoraBrasilia().hoje.split('-').map(Number);
  const atual = ano * 12 + (mes - 1);
  const chave = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  const primeiro = db.prepare('SELECT MIN(substr(data, 1, 7)) AS m FROM lancamentos_gastos WHERE usuario_id = ?').get(req.user.id).m;
  const idxPrimeiro = primeiro ? Number(primeiro.slice(0, 4)) * 12 + Number(primeiro.slice(5, 7)) - 1 : atual;
  const inicioEventual = Math.max(idxPrimeiro, atual - 12);
  const mesesEventual = atual - inicioEventual; // meses fechados observados
  const totais = db.prepare(`SELECT gasto_id, substr(data, 1, 7) AS chave, SUM(valor) AS total FROM lancamentos_gastos
    WHERE usuario_id = ? AND substr(data, 1, 7) BETWEEN ? AND ? GROUP BY gasto_id, chave`)
    .all(req.user.id, chave(Math.min(atual - 3, inicioEventual)), chave(atual - 1));
  const porItem = new Map();
  for (const t of totais) {
    if (!porItem.has(t.gasto_id)) porItem.set(t.gasto_id, new Map());
    porItem.get(t.gasto_id).set(t.chave, Number(t.total) || 0);
  }
  const itens = db.prepare(GASTO_SELECT + "WHERE usuario_id = ? AND categoria <> ? AND classe <> '' ORDER BY id").all(req.user.id, CATEGORIA_NI);
  const sugestoes = [];
  for (const g of itens) {
    const meses = porItem.get(g.id) || new Map();
    if (g.classe.startsWith('Mensal')) {
      const ultimos = [atual - 3, atual - 2, atual - 1].map((i) => ({ mes: chave(i), total: meses.get(chave(i)) || 0 }));
      const comGasto = ultimos.filter((m) => m.total > 0);
      if (!comGasto.length) continue;
      const media = Math.round(comGasto.reduce((s, m) => s + m.total, 0) / comGasto.length);
      sugestoes.push({ id: g.id, descricao: g.descricao, categoria: g.categoria, classe: g.classe, atual: g.valor || 0, sugerido: media,
        base: { tipo: 'media', meses: ultimos, considerados: comGasto.length } });
    } else {
      if (mesesEventual < 1) continue;
      let soma = 0;
      for (let i = inicioEventual; i < atual; i++) soma += meses.get(chave(i)) || 0;
      if (soma <= 0) continue;
      const projecao = Math.round((soma / mesesEventual) * 12);
      sugestoes.push({ id: g.id, descricao: g.descricao, categoria: g.categoria, classe: g.classe, atual: g.valor || 0, sugerido: projecao,
        base: { tipo: 'projecao', de: chave(inicioEventual), ate: chave(atual - 1), meses_observados: mesesEventual, soma: Math.round(soma) } });
    }
  }
  res.json({ referencia: chave(atual), sugestoes });
});

// Visão dos Parcelados: todas as parcelas de compras parceladas do usuário, com o item e a categoria,
// para a Gestão de Pagamentos somar por mês.
app.get('/lancamentos-gastos/parcelados', auth(), (req, res) => {
  const rows = db.prepare(`
    SELECT l.id, l.gasto_id, l.data, l.valor, l.descricao, l.origem, l.recorrencia_grupo, l.parcela, l.total_parcelas,
           g.descricao AS item, g.categoria
    FROM lancamentos_gastos l
    LEFT JOIN gastos g ON g.id = l.gasto_id
    WHERE l.usuario_id = ? AND l.repeticao = 'parcelado'
    ORDER BY l.data, l.id
  `).all(req.user.id);
  res.json(rows);
});

app.get('/lancamentos-gastos', auth(), (req, res) => {
  const { gasto_id, mes } = req.query;
  if (!gasto_id || !/^\d{4}-\d{2}$/.test(String(mes || ''))) return res.status(400).json({ erro: 'Informe gasto_id e mes (AAAA-MM)' });
  const rows = db.prepare(
    'SELECT * FROM lancamentos_gastos WHERE usuario_id = ? AND gasto_id = ? AND data LIKE ? ORDER BY data DESC, id DESC'
  ).all(req.user.id, gasto_id, `${mes}%`);
  res.json(rows);
});

app.post('/lancamentos-gastos', auth(), (req, res) => {
  const { gasto_id, data, valor, descricao, origem } = req.body;
  const gasto = db.prepare('SELECT id FROM gastos WHERE id = ? AND usuario_id = ?').get(gasto_id, req.user.id);
  if (!gasto) return res.status(404).json({ erro: 'Item de gasto não encontrado' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return res.status(400).json({ erro: 'Data inválida (AAAA-MM-DD)' });
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero' });
  const o = ORIGENS_LANCAMENTO.includes(origem) ? origem : 'manual';
  // `meses` > 1 cria a recorrência: um lançamento por mês a partir da data informada (inclusive).
  // `dividir`: parcelado — `valor` é o total, dividido em `meses` parcelas (até 60).
  const dividir = req.body.dividir === true;
  const meses = Math.min(Math.max(parseInt(req.body.meses, 10) || 1, 1), dividir ? 60 : 120);
  const valores = dividir ? dividirEmParcelas(v, meses) : Array(meses).fill(v);
  const grupo = meses > 1 ? `${req.user.id}-${Date.now()}` : null;
  const insert = db.prepare(
    'INSERT INTO lancamentos_gastos (usuario_id, gasto_id, data, valor, descricao, origem, recorrencia_grupo, parcela, total_parcelas, repeticao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const repeticao = grupo ? (dividir ? 'parcelado' : 'recorrencia') : null;
  const ids = db.transaction(() =>
    Array.from({ length: meses }, (_, i) =>
      insert.run(req.user.id, gasto.id, somarMeses(data, i), valores[i], String(descricao || '').trim(), o, grupo,
        grupo ? i + 1 : null, grupo ? meses : null, repeticao).lastInsertRowid
    )
  )();
  const criados = db.prepare(`SELECT * FROM lancamentos_gastos WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY data`).all(...ids);
  res.status(201).json(meses > 1 ? criados : criados[0]);
});

app.put('/lancamentos-gastos/:id', auth(), (req, res) => {
  const atual = db.prepare('SELECT * FROM lancamentos_gastos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!atual) return res.status(404).json({ erro: 'Lançamento não encontrado' });
  const { data, valor, descricao } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return res.status(400).json({ erro: 'Data inválida (AAAA-MM-DD)' });
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero' });
  // Troca de item (categoria/item). Com `item_seguintes`, as próximas parcelas da mesma
  // recorrência/parcelamento também mudam de item (valor e data delas não mudam).
  const gastoId = req.body.gasto_id == null ? atual.gasto_id : Number(req.body.gasto_id);
  const trocouItem = gastoId !== atual.gasto_id;
  if (trocouItem && !db.prepare('SELECT 1 FROM gastos WHERE id = ? AND usuario_id = ?').get(gastoId, req.user.id)) {
    return res.status(400).json({ erro: 'Item inválido' });
  }
  const desc = String(descricao || '').trim();
  const movidos = db.transaction(() => {
    db.prepare('UPDATE lancamentos_gastos SET data = ?, valor = ?, descricao = ?, gasto_id = ? WHERE id = ?').run(data, v, desc, gastoId, atual.id);
    if (!trocouItem) return [];
    aprender(req.user.id, desc, gastoId); // a correção manual ensina o app (exceto Não Identificado)
    if (!req.body.item_seguintes || !atual.recorrencia_grupo) return [];
    const seguintes = db.prepare(
      'SELECT * FROM lancamentos_gastos WHERE usuario_id = ? AND recorrencia_grupo = ? AND id <> ? AND data > ? AND gasto_id = ?'
    ).all(req.user.id, atual.recorrencia_grupo, atual.id, atual.data, atual.gasto_id);
    const mover = db.prepare('UPDATE lancamentos_gastos SET gasto_id = ? WHERE id = ?');
    seguintes.forEach((l) => mover.run(gastoId, l.id));
    return seguintes.map((l) => ({ ...l, gasto_anterior: l.gasto_id, gasto_id: gastoId }));
  })();
  res.json({ ...db.prepare('SELECT * FROM lancamentos_gastos WHERE id = ?').get(atual.id), seguintes_movidos: movidos });
});

// ── Gastos em suspenso (entrada automática, ex.: WhatsApp) ────
// Mensagens que o app não consegue ligar a um item com segurança ficam em suspenso, com uma
// sugestão, até o usuário confirmar, editar ou excluir. Cada confirmação ensina o app
// (gastos_aprendizado) para que o mesmo termo seja lançado sozinho da próxima vez.
db.exec(`
  CREATE TABLE IF NOT EXISTS gastos_suspensos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    texto_original TEXT NOT NULL,
    valor REAL,
    data TEXT,
    descricao TEXT DEFAULT '',
    gasto_sugerido_id INTEGER,
    origem TEXT NOT NULL DEFAULT 'whatsapp',
    criado_em TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS gastos_aprendizado (
    usuario_id INTEGER NOT NULL,
    termo TEXT NOT NULL,
    gasto_id INTEGER NOT NULL,
    atualizado_em TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (usuario_id, termo)
  );
`);
// Itens vindos de fatura: parcela atual (x de y) e um aviso, ex.: possível lançamento repetido.
try { db.prepare('ALTER TABLE gastos_suspensos ADD COLUMN parcela INTEGER').run(); } catch {}
try { db.prepare('ALTER TABLE gastos_suspensos ADD COLUMN total_parcelas INTEGER').run(); } catch {}
try { db.prepare("ALTER TABLE gastos_suspensos ADD COLUMN aviso TEXT DEFAULT ''").run(); } catch {}

// Lança um gasto; se for a parcela x de y, lança da x até a y, uma por mês a partir de `data`.
function lancarComParcelas(usuarioId, { gasto_id, data, valor, descricao, origem, parcela, total_parcelas }) {
  // Até 120 parcelas (10 anos): um total maior vindo da fatura é tratado como compra à vista
  const parcelado = parcela && total_parcelas && total_parcelas > 1 && total_parcelas <= 120 && parcela <= total_parcelas;
  const n = parcelado ? total_parcelas - parcela + 1 : 1;
  const grupo = parcelado ? `${usuarioId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}` : null;
  const insert = db.prepare(
    'INSERT INTO lancamentos_gastos (usuario_id, gasto_id, data, valor, descricao, origem, recorrencia_grupo, parcela, total_parcelas, repeticao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  return Array.from({ length: n }, (_, i) =>
    insert.run(usuarioId, gasto_id, somarMeses(data, i), valor, descricao, origem, grupo,
      parcelado ? parcela + i : null, parcelado ? total_parcelas : null, parcelado ? 'parcelado' : null).lastInsertRowid
  );
}

const PALAVRAS_IGNORADAS = new Set(['de', 'da', 'do', 'das', 'dos', 'no', 'na', 'nos', 'nas', 'em', 'e', 'o', 'a', 'os', 'as',
  'com', 'para', 'pra', 'pro', 'um', 'uma', 'reais', 'real', 'rs', 'r', 'gastei', 'paguei', 'gasto', 'pago', 'compra', 'comprei',
  'hoje', 'ontem', 'anteontem', 'valor', 'conta']);

function normalizarTexto(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function palavrasSignificativas(t) {
  return normalizarTexto(t).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((p) => p.length > 1 && !/^\d+$/.test(p) && !PALAVRAS_IGNORADAS.has(p));
}

// Extrai valor ("50", "R$ 1.200,50", "35.90"), data ("ontem", "05/10", "05/10/2026"; padrão hoje) e o texto restante.
function interpretarMensagem(texto) {
  let resto = String(texto || '');
  let valor = null;
  const mValor = resto.match(/(?:r\$\s*)?(?<![\d/.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d/]|\s*\/|[.,]\d|x\b)/i); // "3x" é número de parcelas, não valor
  if (mValor) {
    const bruto = mValor[1];
    valor = Number(/,\d{1,2}$/.test(bruto) || /\.\d{3}/.test(bruto) ? bruto.replace(/\./g, '').replace(',', '.') : bruto.replace(',', '.'));
    resto = resto.replace(mValor[0], ' ');
  }
  const hoje = new Date();
  let data = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const mData = resto.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (mData) {
    const ano = mData[3] ? (mData[3].length === 2 ? 2000 + Number(mData[3]) : Number(mData[3])) : hoje.getFullYear();
    data = new Date(ano, Number(mData[2]) - 1, Number(mData[1]));
    resto = resto.replace(mData[0], ' ');
  } else if (/\banteontem\b/i.test(normalizarTexto(resto))) {
    data.setDate(data.getDate() - 2);
  } else if (/\bontem\b/i.test(normalizarTexto(resto))) {
    data.setDate(data.getDate() - 1);
  }
  const iso = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
  const descricao = resto
    .replace(/r\$/gi, ' ')
    .replace(/(^|\s)(gastei|paguei|comprei|gasto)(\s+(no|na|nos|nas|em|de|do|da|com))?(?=\s|$)/gi, ' ')
    .replace(/(^|\s)(reais|hoje|ontem|anteontem)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return { valor: Number.isFinite(valor) && valor > 0 ? valor : null, data: iso, descricao };
}

// Procura o item: primeiro no que o usuário já ensinou; depois por palavras em comum com o nome do item.
// `seguro` = pode lançar sem perguntar.
function identificarItem(usuarioId, descricao) {
  const palavras = palavrasSignificativas(descricao);
  if (!palavras.length) return { gasto_id: null, seguro: false };
  const aprendidos = db.prepare(
    `SELECT a.termo, a.gasto_id FROM gastos_aprendizado a JOIN gastos g ON g.id = a.gasto_id AND g.usuario_id = a.usuario_id
     WHERE a.usuario_id = ? AND g.categoria <> ?`
  ).all(usuarioId, CATEGORIA_NI);
  const chave = palavras.join(' ');
  const exato = aprendidos.find((a) => a.termo === chave);
  if (exato) return { gasto_id: exato.gasto_id, seguro: true };
  const porPalavra = aprendidos.filter((a) => palavras.includes(a.termo));
  if (porPalavra.length && new Set(porPalavra.map((a) => a.gasto_id)).size === 1) return { gasto_id: porPalavra[0].gasto_id, seguro: true };

  const itens = db.prepare("SELECT id, descricao FROM gastos WHERE usuario_id = ? AND TRIM(descricao) <> '' AND categoria <> ?").all(usuarioId, CATEGORIA_NI);
  const pontuados = itens.map((g) => {
    const doItem = palavrasSignificativas(g.descricao);
    const comuns = doItem.filter((p) => palavras.some((q) => q === p || (q.length >= 4 && p.startsWith(q)) || (p.length >= 4 && q.startsWith(p))));
    return { id: g.id, pontos: comuns.length, cobertura: doItem.length ? comuns.length / doItem.length : 0 };
  }).filter((p) => p.pontos > 0).sort((a, b) => b.pontos - a.pontos || b.cobertura - a.cobertura);
  if (!pontuados.length) return { gasto_id: null, seguro: false };
  const [melhor, segundo] = pontuados;
  const empate = segundo && segundo.pontos === melhor.pontos && segundo.cobertura === melhor.cobertura;
  return { gasto_id: melhor.id, seguro: !empate && melhor.cobertura === 1 };
}

function aprender(usuarioId, texto, gastoId) {
  if (ehNaoIdentificado(usuarioId, gastoId)) return; // classificar como Não Identificado não ensina nada
  const chave = palavrasSignificativas(texto).join(' ');
  if (!chave) return;
  db.prepare(
    `INSERT INTO gastos_aprendizado (usuario_id, termo, gasto_id) VALUES (?, ?, ?)
     ON CONFLICT(usuario_id, termo) DO UPDATE SET gasto_id = excluded.gasto_id, atualizado_em = datetime('now')`
  ).run(usuarioId, chave, gastoId);
}

// Porta de entrada da integração: recebe a mensagem e lança direto ou deixa em suspenso.
app.post('/gastos-suspensos/entrada', auth(), (req, res) => {
  const texto = String(req.body.texto || '').trim();
  if (!texto) return res.status(400).json({ erro: 'Mensagem vazia' });
  const origem = ORIGENS_LANCAMENTO.includes(req.body.origem) ? req.body.origem : 'whatsapp';
  const { valor, data, descricao } = interpretarMensagem(texto);
  const { gasto_id, seguro } = identificarItem(req.user.id, descricao);
  if (seguro && valor) {
    const r = db.prepare(
      'INSERT INTO lancamentos_gastos (usuario_id, gasto_id, data, valor, descricao, origem) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, gasto_id, data, valor, descricao, origem);
    return res.status(201).json({ resultado: 'lancado', lancamento: db.prepare('SELECT * FROM lancamentos_gastos WHERE id = ?').get(r.lastInsertRowid) });
  }
  const r = db.prepare(
    'INSERT INTO gastos_suspensos (usuario_id, texto_original, valor, data, descricao, gasto_sugerido_id, origem) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, texto, valor, data, descricao, gasto_id, origem);
  res.status(201).json({ resultado: 'suspenso', suspenso: db.prepare('SELECT * FROM gastos_suspensos WHERE id = ?').get(r.lastInsertRowid) });
});

app.get('/gastos-suspensos', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM gastos_suspensos WHERE usuario_id = ? ORDER BY criado_em DESC, id DESC').all(req.user.id));
});

app.put('/gastos-suspensos/:id', auth(), (req, res) => {
  const atual = db.prepare('SELECT * FROM gastos_suspensos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!atual) return res.status(404).json({ erro: 'Gasto em suspenso não encontrado' });
  const { gasto_sugerido_id, valor, data, descricao } = req.body;
  if (gasto_sugerido_id && !db.prepare('SELECT 1 FROM gastos WHERE id = ? AND usuario_id = ?').get(gasto_sugerido_id, req.user.id)) {
    return res.status(400).json({ erro: 'Item inválido' });
  }
  if (data && !/^\d{4}-\d{2}-\d{2}$/.test(String(data))) return res.status(400).json({ erro: 'Data inválida (AAAA-MM-DD)' });
  const v = valor === null || valor === '' || valor === undefined ? null : Number(valor);
  db.prepare('UPDATE gastos_suspensos SET gasto_sugerido_id = ?, valor = ?, data = ?, descricao = ? WHERE id = ?')
    .run(gasto_sugerido_id || null, Number.isFinite(v) && v > 0 ? v : null, data || atual.data, String(descricao ?? atual.descricao).trim(), atual.id);
  res.json(db.prepare('SELECT * FROM gastos_suspensos WHERE id = ?').get(atual.id));
});

// Valida e lança um gasto em suspenso (com as parcelas seguintes, se for parcela de fatura), apaga o
// suspenso e ensina o app. Chame dentro de uma transação. Devolve { erro } ou { criados }.
function confirmarSuspenso(usuarioId, atual, corpo) {
  const gastoId = corpo.gasto_id ?? atual.gasto_sugerido_id;
  const data = corpo.data ?? atual.data;
  const valor = Number(corpo.valor ?? atual.valor);
  const descricao = String(corpo.descricao ?? atual.descricao ?? '').trim();
  if (!gastoId || !db.prepare('SELECT 1 FROM gastos WHERE id = ? AND usuario_id = ?').get(gastoId, usuarioId)) {
    return { erro: 'Escolha o item do gasto' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return { erro: 'Informe a data' };
  if (!Number.isFinite(valor) || valor <= 0) return { erro: 'Informe um valor maior que zero' };
  const ids = lancarComParcelas(usuarioId, {
    gasto_id: gastoId, data, valor, descricao, origem: atual.origem, parcela: atual.parcela, total_parcelas: atual.total_parcelas,
  });
  db.prepare('DELETE FROM gastos_suspensos WHERE id = ?').run(atual.id);
  aprender(usuarioId, atual.descricao || atual.texto_original, gastoId);
  return { criados: db.prepare(`SELECT * FROM lancamentos_gastos WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY data`).all(...ids) };
}

app.post('/gastos-suspensos/:id/confirmar', auth(), (req, res) => {
  const atual = db.prepare('SELECT * FROM gastos_suspensos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!atual) return res.status(404).json({ erro: 'Gasto em suspenso não encontrado' });
  const r = db.transaction(() => confirmarSuspenso(req.user.id, atual, req.body))();
  if (r.erro) return res.status(400).json({ erro: r.erro });
  res.status(201).json(r.criados);
});

// Vários de uma vez no mesmo item (ex.: todas as compras de um fornecedor). Cada um leva o próprio
// valor, data e descrição. Os que não passarem na validação ficam em suspenso e voltam em `falhas`.
app.post('/gastos-suspensos/confirmar-lote', auth(), (req, res) => {
  const gastoId = Number(req.body.gasto_id);
  const itens = Array.isArray(req.body.itens) ? req.body.itens.slice(0, 500) : [];
  if (!gastoId || !db.prepare('SELECT 1 FROM gastos WHERE id = ? AND usuario_id = ?').get(gastoId, req.user.id)) {
    return res.status(400).json({ erro: 'Escolha o item do gasto' });
  }
  const buscar = db.prepare('SELECT * FROM gastos_suspensos WHERE id = ? AND usuario_id = ?');
  const resultado = db.transaction(() => {
    const r = { lancados: [], criados: [], falhas: [] };
    for (const it of itens) {
      const atual = buscar.get(it.id, req.user.id);
      if (!atual) { r.falhas.push({ id: it.id, erro: 'Gasto em suspenso não encontrado' }); continue; }
      const c = confirmarSuspenso(req.user.id, atual, { gasto_id: gastoId, data: it.data, valor: it.valor, descricao: it.descricao });
      if (c.erro) { r.falhas.push({ id: atual.id, erro: c.erro }); continue; }
      r.lancados.push(atual.id);
      r.criados.push(...c.criados);
    }
    return r;
  })();
  res.status(201).json(resultado);
});

app.delete('/gastos-suspensos/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM gastos_suspensos WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// `?seguintes=1` apaga também os próximos lançamentos da mesma recorrência.
app.delete('/lancamentos-gastos/:id', auth(), (req, res) => {
  const atual = db.prepare('SELECT * FROM lancamentos_gastos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!atual) return res.json({ ok: true, removidos: [] });
  const removidos = req.query.seguintes === '1' && atual.recorrencia_grupo
    ? db.prepare('SELECT * FROM lancamentos_gastos WHERE usuario_id = ? AND recorrencia_grupo = ? AND data >= ?').all(req.user.id, atual.recorrencia_grupo, atual.data)
    : [atual];
  const del = db.prepare('DELETE FROM lancamentos_gastos WHERE id = ?');
  db.transaction(() => removidos.forEach((l) => del.run(l.id)))();
  res.json({ ok: true, removidos });
});

// ── Importação de fatura do cartão ────────────────────────────
// Lê a fatura (PDF pela IA; CSV e OFX aqui mesmo) e trata cada compra como uma mensagem de gasto:
// item reconhecido → lança na data da compra; não reconhecido → fica em suspenso (com sugestão da IA).
// Compra parcelada "x/y" → lança da parcela x até a y, mês a mês. Se já existir lançamento com a mesma
// data, valor e estabelecimento, vai para suspenso com aviso, para o usuário decidir.

// "R$ 1.234,56", "-50,00", "1234.56", "(12,30)" → número com sinal.
function lerValor(bruto) {
  let s = String(bruto ?? '').trim();
  if (!s) return NaN;
  const negativo = /^\(.*\)$/.test(s) || /^-|-$/.test(s.replace(/r\$\s*/i, '').trim());
  s = s.replace(/[^\d.,]/g, '');
  const ultVirgula = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
  if (ultVirgula > ultPonto) s = s.replace(/\./g, '').replace(',', '.');
  else if (ultPonto > ultVirgula && ultVirgula >= 0) s = s.replace(/,/g, '');
  else if (ultPonto >= 0 && s.indexOf('.') !== ultPonto) s = s.replace(/\./g, ''); // "1.234.567"
  const v = Number(s);
  return Number.isFinite(v) ? (negativo ? -v : v) : NaN;
}

const iso = (a, m, d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// "2026-10-05", "05/10/2026", "05/10/26", "20261005" ou "05/10" (ano deduzido: a compra não fica no futuro).
function lerData(bruto) {
  const s = String(bruto ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/))) {
    const hoje = new Date();
    let ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : hoje.getFullYear();
    if (!m[3] && new Date(ano, Number(m[2]) - 1, Number(m[1])) > hoje) ano -= 1;
    return iso(ano, m[2], m[1]);
  }
  return null;
}

// Separa "LOJA X 03/10", "LOJA X PARC 03/10" ou "Loja X - Parcela 3/10" em descrição + parcela.
function separarParcela(descricao) {
  const m = String(descricao || '').match(/\s*[-–]?\s*(?:parc(?:ela)?\.?\s*)?(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\s*$/i);
  if (m) {
    const parcela = Number(m[1]), total = Number(m[2]);
    if (parcela >= 1 && total >= 2 && parcela <= total) {
      return { descricao: descricao.slice(0, m.index).trim(), parcela, total_parcelas: total };
    }
  }
  return { descricao: String(descricao || '').trim(), parcela: null, total_parcelas: null };
}

function dividirLinhaCsv(linha, sep) {
  const campos = [];
  let atual = '', aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') { if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas; }
    else if (c === sep && !aspas) { campos.push(atual); atual = ''; }
    else atual += c;
  }
  campos.push(atual);
  return campos.map((c) => c.trim());
}

function lerCsv(texto) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  const acharColuna = (cab, re, evitar) => cab.findIndex((c) => re.test(c) && !(evitar && evitar.test(c)));
  for (let i = 0; i < Math.min(linhas.length, 30); i++) {
    const sep = [';', '\t', ','].sort((a, b) => linhas[i].split(b).length - linhas[i].split(a).length)[0];
    const cab = dividirLinhaCsv(linhas[i], sep).map(normalizarTexto);
    const cData = acharColuna(cab, /^(data|date|dt)\b/);
    const cDesc = acharColuna(cab, /descri|lancamento|historico|estabelecimento|title|titulo|memo|loja/);
    const cValor = acharColuna(cab, /valor|amount|vlr|quantia/, /us\$|usd|dolar|cotacao/);
    if (cData < 0 || cDesc < 0 || cValor < 0) continue;
    return linhas.slice(i + 1).map((l) => dividirLinhaCsv(l, sep))
      .map((c) => ({ data: lerData(c[cData]), descricao: c[cDesc] || '', valor: lerValor(c[cValor]) }))
      .filter((l) => l.data && Number.isFinite(l.valor));
  }
  throw new Error('Não encontrei as colunas de data, descrição e valor neste CSV.');
}

function lerOfx(texto) {
  const campo = (bloco, tag) => (bloco.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i')) || [])[1]?.trim() || '';
  return texto.split(/<STMTTRN>/i).slice(1)
    .map((b) => ({ data: lerData(campo(b, 'DTPOSTED')), descricao: campo(b, 'MEMO') || campo(b, 'NAME'), valor: lerValor(campo(b, 'TRNAMT')) }))
    .filter((l) => l.data && Number.isFinite(l.valor));
}

// PDF protegido por senha (comum em faturas: dígitos do CPF). A IA não lê PDF criptografado, então
// abrimos aqui com a senha e mandamos só o texto, linha a linha. A senha não é guardada nem registrada.
class SenhaPdfError extends Error {
  constructor(incorreta) {
    super(incorreta ? 'Senha incorreta.' : 'Este PDF é protegido por senha.');
    this.codigo = incorreta ? 'SENHA_INCORRETA' : 'SENHA_NECESSARIA';
  }
}

const pdfCriptografado = (buffer) => buffer.includes('/Encrypt');

async function textoDoPdf(buffer, senha) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const tarefa = pdfjs.getDocument({ data: new Uint8Array(buffer), password: senha || undefined, isEvalSupported: false, useSystemFonts: false });
  let doc;
  try {
    doc = await tarefa.promise;
  } catch (e) {
    tarefa.destroy();
    if (e?.name === 'PasswordException') throw new SenhaPdfError(e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    throw new Error('Não foi possível abrir este PDF.');
  }
  const paginas = [];
  try {
  for (let n = 1; n <= doc.numPages; n++) {
    const { items } = await (await doc.getPage(n)).getTextContent();
    // Agrupa os trechos pela altura na página (mesma linha) e ordena da esquerda para a direita.
    const linhas = new Map();
    for (const it of items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      if (!linhas.has(y)) linhas.set(y, []);
      linhas.get(y).push({ x: it.transform[4], str: it.str.trim() });
    }
    const texto = [...linhas.entries()].sort((a, b) => b[0] - a[0])
      .map(([, trechos]) => trechos.sort((a, b) => a.x - b.x).map((t) => t.str).join('  '))
      .join('\n');
    paginas.push(`--- Página ${n} ---\n${texto}`);
  }
  } catch {
    throw new Error('Não foi possível ler o texto deste PDF.');
  } finally {
    tarefa.destroy();
  }
  return paginas.join('\n\n');
}

const MODELO_IA = 'claude-opus-5-5';

// Chamada com saída em JSON garantida pelo schema. Fallback do servidor caso o modelo recuse.
async function perguntarIA(content, schema, maxTokens) {
  const client = new Anthropic();
  const msg = await client.beta.messages.stream({
    model: MODELO_IA,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('A IA não conseguiu ler este arquivo.');
  if (msg.stop_reason === 'max_tokens') throw new Error('A fatura é grande demais para ler de uma vez.');
  const texto = msg.content.find((b) => b.type === 'text')?.text;
  return JSON.parse(texto || '{}');
}

// `textoExtraido`: PDF que estava protegido por senha, já aberto aqui (vai como texto em vez do arquivo).
async function lerFaturaPdf(buffer, textoExtraido) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['transacoes'],
    properties: {
      transacoes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['data', 'descricao', 'valor', 'parcela', 'total_parcelas', 'tipo'],
          properties: {
            data: { type: 'string', description: 'AAAA-MM-DD' },
            descricao: { type: 'string' },
            valor: { type: 'number' },
            parcela: { type: 'integer' },
            total_parcelas: { type: 'integer' },
            tipo: { type: 'string', enum: ['compra', 'credito'] },
          },
        },
      },
    },
  };
  const r = await perguntarIA([
    textoExtraido
      ? { type: 'text', text: `<fatura>\n${textoExtraido}\n</fatura>` }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
    { type: 'text', text: `Esta é a fatura de um cartão de crédito brasileiro. Liste todos os lançamentos dela, de todos os cartões (titular e adicionais), na ordem em que aparecem.

Para cada lançamento:
- data: a data impressa na linha, em AAAA-MM-DD. Deduza o ano pelo período da fatura: uma data com mês posterior ao do fechamento é do ano anterior.
- descricao: o nome do estabelecimento como está impresso, sem o indicador de parcela.
- valor: valor em reais, sempre positivo. Em compras internacionais, use o valor já convertido em R$.
- parcela e total_parcelas: para compras parceladas ("03/10", "PARC 03/10", "Parcela 3 de 10"), a parcela atual e o total; para compras à vista, 0 e 0.
- tipo: "credito" para pagamentos da fatura, estornos, devoluções, créditos e descontos; "compra" para compras, saques, tarifas, anuidade, IOF, juros e encargos.

Ignore linhas de resumo e totais (total da fatura, saldo anterior, limite, pagamento mínimo, subtotais).
Ignore também as listas de parcelas de faturas futuras (ex.: "Compras parceladas - próximas faturas"): elas ainda não foram cobradas e o app já lança as próximas parcelas sozinho.
Lançamentos sem data própria (ex.: "Repasse de IOF") usam a data de fechamento da fatura.
Confira: a soma das compras menos os créditos deve bater com os lançamentos atuais da fatura.` },
  ], schema, 64000);
  return transacoesParaLinhas(r.transacoes);
}

// Converte as transações no formato do schema (resposta da IA) nas linhas da importação.
function transacoesParaLinhas(transacoes) {
  return (Array.isArray(transacoes) ? transacoes : []).map((t) => ({
    data: lerData(t.data),
    descricao: String(t.descricao || '').trim(),
    valor: t.tipo === 'credito' ? -Math.abs(Number(t.valor)) : Math.abs(Number(t.valor)),
    parcela: t.total_parcelas > 1 && t.parcela >= 1 && t.parcela <= t.total_parcelas ? t.parcela : null,
    total_parcelas: t.total_parcelas > 1 && t.parcela >= 1 && t.parcela <= t.total_parcelas ? t.total_parcelas : null,
  })).filter((l) => l.data && Number.isFinite(l.valor));
}

// Sugere o item para os estabelecimentos que as regras não reconheceram. Só sugestão: o usuário confirma.
async function sugerirItensIA(usuarioId, descricoes) {
  if (!descricoes.length) return new Map();
  const itens = db.prepare("SELECT id, categoria, descricao FROM gastos WHERE usuario_id = ? AND TRIM(descricao) <> '' AND categoria <> ?").all(usuarioId, CATEGORIA_NI);
  const schema = {
    type: 'object', additionalProperties: false, required: ['sugestoes'],
    properties: {
      sugestoes: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['indice', 'item_id'],
          properties: { indice: { type: 'integer' }, item_id: { type: 'integer' } },
        },
      },
    },
  };
  const r = await perguntarIA([{ type: 'text', text: `Classifique cada estabelecimento de uma fatura de cartão em um dos itens de orçamento do usuário.
Use item_id 0 quando nenhum item servir com razoável certeza.

Itens (id | categoria | item):
${itens.map((i) => `${i.id} | ${i.categoria} | ${i.descricao}`).join('\n')}

Estabelecimentos (índice | descrição):
${descricoes.map((d, i) => `${i} | ${d}`).join('\n')}` }], schema, 16000);
  const validos = new Set(itens.map((i) => i.id));
  return new Map((r.sugestoes || []).filter((s) => validos.has(s.item_id)).map((s) => [descricoes[s.indice], s.item_id]));
}

const ehPagamentoDaFatura = (d) => /\bpagamento\b.*\b(recebido|efetuado|fatura)\b|\bpgto\b|\bpagto\b/i.test(normalizarTexto(d));
const chaveCompra = (data, valor, descricao) => `${data}|${Math.round(valor * 100)}|${palavrasSignificativas(descricao).join(' ')}`;

// Da lista de lançamentos lidos (de qualquer formato) ao resultado: lança, deixa em suspenso ou ignora.
// `sugerir(descricoes)` devolve Map descrição → item para o que as regras não reconheceram.
async function processarLinhas(usuarioId, linhas, {
  ehPdf,
  sugerir = process.env.ANTHROPIC_API_KEY ? (d) => sugerirItensIA(usuarioId, d) : null,
}) {
  // CSV/OFX: cada banco usa um sinal. Se a maioria vier negativa, as compras são as negativas.
  if (!ehPdf && linhas.filter((l) => l.valor < 0).length > linhas.filter((l) => l.valor > 0).length) {
    linhas.forEach((l) => { l.valor = -l.valor; });
  }

  const compras = [];
  let ignorados = 0;
  for (const l of linhas) {
    if (l.valor <= 0 || ehPagamentoDaFatura(l.descricao)) { ignorados++; continue; }
    const p = l.parcela ? { descricao: separarParcela(l.descricao).descricao, parcela: l.parcela, total_parcelas: l.total_parcelas } : separarParcela(l.descricao);
    const descricao = p.descricao || l.descricao.trim();
    // A data impressa é a da compra; a parcela x cai x-1 meses depois.
    const data = p.parcela ? somarMeses(l.data, p.parcela - 1) : l.data;
    compras.push({ original: l.descricao.trim(), descricao, data, valor: Math.round(l.valor * 100) / 100, parcela: p.parcela, total_parcelas: p.total_parcelas });
  }

  // O que já existe com mesma data, valor e estabelecimento (contado antes de gravar, para que
  // duas compras iguais na mesma fatura não acusem uma à outra).
  const datas = compras.map((c) => c.data).sort();
  const contar = (rows) => rows.reduce((m, r) => {
    const k = chaveCompra(r.data, r.valor, r.descricao);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r.gasto_id);
    return m;
  }, new Map());
  const jaLancados = compras.length ? contar(db.prepare(
    'SELECT data, valor, descricao, gasto_id FROM lancamentos_gastos WHERE usuario_id = ? AND data BETWEEN ? AND ?'
  ).all(usuarioId, datas[0], datas[datas.length - 1])) : new Map();
  const jaSuspensos = contar(db.prepare(
    'SELECT data, valor, descricao, gasto_sugerido_id AS gasto_id FROM gastos_suspensos WHERE usuario_id = ?'
  ).all(usuarioId));

  const vistos = new Map();
  const planos = compras.map((c) => {
    const k = chaveCompra(c.data, c.valor, c.descricao);
    const n = (vistos.get(k) || 0) + 1;
    vistos.set(k, n);
    const emSuspenso = jaSuspensos.get(k)?.length || 0;
    if (n <= emSuspenso) return { ...c, acao: 'ja_em_suspenso' };
    const lancados = jaLancados.get(k) || [];
    if (n - emSuspenso <= lancados.length) {
      const aviso = c.parcela
        ? `A parcela ${c.parcela}/${c.total_parcelas} desta compra já foi lançada (mesma data, valor e estabelecimento). Confirme só se for outra compra — as parcelas seguintes também serão lançadas.`
        : 'Já existe um lançamento com a mesma data, valor e estabelecimento. Confirme só se for outra compra.';
      const anterior = lancados[n - emSuspenso - 1];
      return { ...c, acao: 'suspender', gasto_id: ehNaoIdentificado(usuarioId, anterior) ? null : anterior, aviso, duplicado: true };
    }
    const { gasto_id, seguro } = identificarItem(usuarioId, c.descricao);
    return { ...c, acao: seguro ? 'lancar' : 'suspender', gasto_id, aviso: '' };
  });

  const semSugestao = [...new Set(planos.filter((p) => p.acao === 'suspender' && !p.gasto_id).map((p) => p.descricao))];
  if (sugerir) try {
    const sugestoes = await sugerir(semSugestao);
    planos.forEach((p) => { if (p.acao === 'suspender' && !p.gasto_id) p.gasto_id = sugestoes.get(p.descricao) || null; });
  } catch (e) {
    console.warn('[fatura] sem sugestões da IA:', e?.message); // segue sem sugestão: o usuário escolhe o item
  }

  const insertSuspenso = db.prepare(
    `INSERT INTO gastos_suspensos (usuario_id, texto_original, valor, data, descricao, gasto_sugerido_id, origem, parcela, total_parcelas, aviso)
     VALUES (?, ?, ?, ?, ?, ?, 'fatura', ?, ?, ?)`
  );
  const resumo = db.transaction(() => {
    const r = { lidos: linhas.length, lancados: 0, parcelas_lancadas: 0, suspensos: 0, duplicados: 0, ja_em_suspenso: 0, ignorados };
    for (const p of planos) {
      if (p.acao === 'ja_em_suspenso') { r.ja_em_suspenso++; continue; }
      if (p.acao === 'lancar') {
        r.parcelas_lancadas += lancarComParcelas(usuarioId, { ...p, origem: 'fatura' }).length;
        r.lancados++;
        continue;
      }
      insertSuspenso.run(usuarioId, p.original, p.valor, p.data, p.descricao, p.gasto_id || null, p.parcela, p.total_parcelas, p.aviso);
      r.suspensos++;
      if (p.duplicado) r.duplicados++;
    }
    return r;
  })();
  return resumo;
}

app.post('/faturas/importar', auth(), iaLimiter, async (req, res) => {
  const nome = String(req.body.nome_arquivo || '');
  const buffer = Buffer.from(String(req.body.conteudo_base64 || ''), 'base64');
  if (!buffer.length) return res.status(400).json({ erro: 'Envie o arquivo da fatura.' });
  // O cabeçalho %PDF- pode vir depois de alguns bytes (a especificação tolera até 1 KB antes dele).
  const ehPdf = buffer.subarray(0, 1024).includes('%PDF-') || /\.pdf$/i.test(nome);
  const falhar = (status, corpo) => {
    console.warn(`[fatura] ${status} ${nome} (${buffer.length} bytes, ${ehPdf ? 'pdf' : 'texto'}): ${corpo.codigo || corpo.erro}`);
    return res.status(status).json(corpo);
  };
  let texto = '';
  if (!ehPdf) {
    texto = buffer.toString('utf8');
    if (texto.includes('�')) texto = buffer.toString('latin1'); // CSV de banco costuma vir em Latin-1
  }
  const ehOfx = !ehPdf && (/\.ofx$/i.test(nome) || /<OFX>/i.test(texto));

  // PDF com senha: abre antes de tudo para pedir (ou conferir) a senha ao usuário.
  let textoPdf = null;
  if (ehPdf && pdfCriptografado(buffer)) {
    try {
      textoPdf = await textoDoPdf(buffer, String(req.body.senha || ''));
    } catch (e) {
      if (e instanceof SenhaPdfError) return falhar(422, { erro: e.message, codigo: e.codigo });
      console.error('[fatura] falha ao abrir o PDF', nome, e?.message);
      return falhar(422, { erro: 'Não foi possível abrir este PDF. Confira o arquivo e tente de novo.' });
    }
    if (!textoPdf.replace(/--- Página \d+ ---/g, '').trim()) {
      return falhar(422, { erro: 'Este PDF não tem texto legível (parece uma imagem digitalizada).' });
    }
  }

  if (ehPdf && !process.env.ANTHROPIC_API_KEY) {
    return falhar(503, { erro: 'A leitura de PDF ainda não está configurada no servidor. Por enquanto, importe a fatura em CSV ou OFX.' });
  }

  let linhas;
  try {
    linhas = ehPdf ? await lerFaturaPdf(buffer, textoPdf) : ehOfx ? lerOfx(texto) : lerCsv(texto);
  } catch (e) {
    console.error('[fatura] falha ao ler', nome, e?.message);
    const falhaIA = e instanceof Anthropic.AnthropicError || e instanceof SyntaxError;
    return falhar(falhaIA ? 502 : 422, { erro: falhaIA ? 'Não foi possível ler o PDF agora. Tente de novo em instantes.' : e.message });
  }
  if (!linhas.length) return falhar(422, { erro: 'Nenhum lançamento encontrado no arquivo.' });

  const resumo = await processarLinhas(req.user.id, linhas, { ehPdf });
  res.status(201).json(resumo);
});

// Só desenvolvimento (DEV_SEM_LOGIN=1, pedido do próprio Mac): recebe as transações já extraídas, no
// mesmo formato que a IA devolve, e segue o mesmo processamento. Serve para testar sem gastar créditos.
// `sugestoes` (opcional): { "descrição do estabelecimento": id_do_item } no lugar da sugestão da IA.
if (process.env.DEV_SEM_LOGIN === '1') {
  app.post('/faturas/importar-transacoes', auth(), async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local) return res.status(403).json({ erro: 'Disponível só localmente' });
    const linhas = transacoesParaLinhas(req.body.transacoes);
    if (!linhas.length) return res.status(422).json({ erro: 'Nenhum lançamento válido em "transacoes".' });
    const mapa = new Map(Object.entries(req.body.sugestoes || {}).map(([d, id]) => [d, Number(id)]));
    const validos = new Set(db.prepare('SELECT id FROM gastos WHERE usuario_id = ? AND categoria <> ?').all(req.user.id, CATEGORIA_NI).map((g) => g.id));
    const sugerir = async (descricoes) => new Map(descricoes.filter((d) => validos.has(mapa.get(d))).map((d) => [d, mapa.get(d)]));
    res.status(201).json(await processarLinhas(req.user.id, linhas, { ehPdf: true, sugerir }));
  });
}


// ── Dívidas ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS dividas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    guia TEXT NOT NULL DEFAULT 'financeiros',
    nome TEXT NOT NULL DEFAULT '',
    quitado INTEGER NOT NULL DEFAULT 0,
    modalidade TEXT NOT NULL DEFAULT '',
    pmt REAL NOT NULL DEFAULT 0,
    parcelas_totais INTEGER,
    parcelas_restantes INTEGER,
    quitacao_a_vista REAL NOT NULL DEFAULT 0,
    taxa TEXT NOT NULL DEFAULT '',
    correcao TEXT NOT NULL DEFAULT 'NÃO HÁ',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_dividas_usuario_id ON dividas(usuario_id)');

const DIVIDA_SELECT = `SELECT id, usuario_id, guia, nome, quitado, modalidade, pmt, parcelas_totais, parcelas_restantes, quitacao_a_vista, taxa, correcao, criado_em FROM dividas `;

app.get('/dividas', auth(), (req, res) => {
  res.json(db.prepare(DIVIDA_SELECT + 'WHERE usuario_id = ? ORDER BY id').all(req.user.id).map(d => ({ ...d, quitado: !!d.quitado })));
});

// Campos da dívida conferidos e normalizados; devolve { erro } ou a lista de valores na ordem das colunas
const MODALIDADES_DIVIDA = ['', 'SAC', 'PRICE', 'Outro'];
const CORRECOES = ['NÃO HÁ', 'IPCA', 'IGP-M', 'TR', 'SELIC', 'INPC'];
const numOk = (v, max = 1e10) => { const n = Number(v ?? 0); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
const parcelasOk = (v) => (v === null || v === undefined || v === '' ? null
  : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 1200 ? Number(v) : undefined);
function camposDivida(b) {
  const guia = b.guia || 'financeiros', modalidade = b.modalidade || '', correcao = b.correcao || 'NÃO HÁ';
  if (!['imobilizados', 'financeiros'].includes(guia)) return { erro: 'Guia inválida' };
  if (!MODALIDADES_DIVIDA.includes(modalidade)) return { erro: 'Modalidade inválida' };
  if (!CORRECOES.includes(correcao)) return { erro: 'Correção inválida' };
  const pmt = numOk(b.pmt), quitacao = numOk(b.quitacao_a_vista);
  const totais = parcelasOk(b.parcelas_totais), restantes = parcelasOk(b.parcelas_restantes);
  if (pmt === null || quitacao === null) return { erro: 'Valor inválido' };
  if (totais === undefined || restantes === undefined) return { erro: 'Número de parcelas inválido (0 a 1200)' };
  return { valores: [guia, String(b.nome ?? '').trim().slice(0, 120), b.quitado ? 1 : 0, modalidade, pmt, totais, restantes, quitacao,
    String(b.taxa ?? '').slice(0, 40), correcao] };
}

app.post('/dividas', auth(), (req, res) => {
  const c = camposDivida(req.body);
  if (c.erro) return res.status(400).json({ erro: c.erro });
  const r = db.prepare(
    'INSERT INTO dividas (usuario_id, guia, nome, quitado, modalidade, pmt, parcelas_totais, parcelas_restantes, quitacao_a_vista, taxa, correcao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, ...c.valores);
  const row = db.prepare(DIVIDA_SELECT + 'WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ ...row, quitado: !!row.quitado });
});

app.put('/dividas/:id', auth(), (req, res) => {
  const c = camposDivida(req.body);
  if (c.erro) return res.status(400).json({ erro: c.erro });
  db.prepare(
    'UPDATE dividas SET guia=?, nome=?, quitado=?, modalidade=?, pmt=?, parcelas_totais=?, parcelas_restantes=?, quitacao_a_vista=?, taxa=?, correcao=? WHERE id=? AND usuario_id=?'
  ).run(...c.valores, req.params.id, req.user.id);
  const row = db.prepare(DIVIDA_SELECT + 'WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ erro: 'Dívida não encontrada' });
  res.json({ ...row, quitado: !!row.quitado });
});

app.delete('/dividas/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM dividas WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Ativos ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ativos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    guia TEXT NOT NULL DEFAULT 'imobilizados',
    nome TEXT NOT NULL DEFAULT '',
    valor_aquisicao REAL NOT NULL DEFAULT 0,
    valor_atual REAL NOT NULL DEFAULT 0,
    rendimento_mensal REAL NOT NULL DEFAULT 0,
    taxa TEXT NOT NULL DEFAULT '',
    correcao TEXT NOT NULL DEFAULT 'NÃO HÁ',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_ativos_usuario_id ON ativos(usuario_id)');

// Ativos financeiros usam nome, valor_atual (Valor Investido) e classe; os imobilizados usam as demais colunas.
try { db.prepare("ALTER TABLE ativos ADD COLUMN classe TEXT NOT NULL DEFAULT ''").run(); } catch {}
const CLASSES_ATIVO = ['Pós Fixado', 'Pré Fixado', 'Inflação', 'Fundo Multimercado', 'FII', 'Ações', 'Alternativo'];
const classeAtivo = (v) => (CLASSES_ATIVO.includes(v) ? v : '');

const ATIVO_SELECT = `SELECT id, usuario_id, guia, nome, valor_aquisicao, valor_atual, rendimento_mensal, taxa, correcao, classe, criado_em FROM ativos `;

app.get('/ativos', auth(), (req, res) => {
  res.json(db.prepare(ATIVO_SELECT + 'WHERE usuario_id = ? ORDER BY id').all(req.user.id));
});

app.post('/ativos', auth(), (req, res) => {
  const { guia, nome, valor_aquisicao, valor_atual, rendimento_mensal, taxa, correcao, classe } = req.body;
  const r = db.prepare(
    'INSERT INTO ativos (usuario_id, guia, nome, valor_aquisicao, valor_atual, rendimento_mensal, taxa, correcao, classe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, guia || 'imobilizados', nome || '', Number(valor_aquisicao) || 0, Number(valor_atual) || 0, Number(rendimento_mensal) || 0, taxa || '', correcao || 'NÃO HÁ', classeAtivo(classe));
  res.status(201).json(db.prepare(ATIVO_SELECT + 'WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/ativos/:id', auth(), (req, res) => {
  const { guia, nome, valor_aquisicao, valor_atual, rendimento_mensal, taxa, correcao, classe } = req.body;
  db.prepare(
    'UPDATE ativos SET guia=?, nome=?, valor_aquisicao=?, valor_atual=?, rendimento_mensal=?, taxa=?, correcao=?, classe=? WHERE id=? AND usuario_id=?'
  ).run(guia || 'imobilizados', nome || '', Number(valor_aquisicao) || 0, Number(valor_atual) || 0, Number(rendimento_mensal) || 0, taxa || '', correcao || 'NÃO HÁ', classeAtivo(classe), req.params.id, req.user.id);
  const ativo = db.prepare(ATIVO_SELECT + 'WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!ativo) return res.status(404).json({ erro: 'Ativo não encontrado' });
  res.json(ativo);
});

app.delete('/ativos/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM ativos WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Sonhos ────────────────────────────────────────────────────────────────────
db.prepare(`
  CREATE TABLE IF NOT EXISTS sonhos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER NOT NULL,
    nome          TEXT    NOT NULL DEFAULT '',
    descricao     TEXT    NOT NULL DEFAULT '',
    valor_total   REAL,
    prazo         INTEGER NOT NULL DEFAULT 12,
    rentabilidade REAL    NOT NULL DEFAULT 1.0,
    valor_inicial REAL,
    data_inicio   TEXT    NOT NULL DEFAULT '',
    valor_selado  REAL,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`).run();

db.exec('CREATE INDEX IF NOT EXISTS idx_sonhos_usuario_id ON sonhos(usuario_id)');

// migration: add descricao if missing
try { db.prepare('ALTER TABLE sonhos ADD COLUMN descricao TEXT NOT NULL DEFAULT \'\'').run(); } catch {}

app.get('/sonhos', auth(), (req, res) => {
  const rows = db.prepare('SELECT * FROM sonhos WHERE usuario_id = ? ORDER BY id').all(req.user.id);
  res.json(rows);
});

// Campos do sonho conferidos; valores vazios ficam null (o app calcula o que falta)
const numOuNull = (v, min, max) => (v === null || v === undefined || v === '' ? null
  : Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined);
function camposSonho(b) {
  const valor_total = numOuNull(b.valor_total, 0, 1e10), valor_inicial = numOuNull(b.valor_inicial, 0, 1e10);
  const valor_selado = numOuNull(b.valor_selado, 0, 1e10), rentabilidade = numOuNull(b.rentabilidade ?? 1.0, -100, 100);
  const prazo = b.prazo ?? 12;
  if ([valor_total, valor_inicial, valor_selado].includes(undefined)) return { erro: 'Valor inválido' };
  if (rentabilidade === undefined || rentabilidade === null) return { erro: 'Rentabilidade inválida' };
  if (!Number.isInteger(Number(prazo)) || Number(prazo) < 0 || Number(prazo) > 1200) return { erro: 'Prazo inválido (0 a 1200 meses)' };
  const data = String(b.data_inicio ?? '');
  if (data && !/^\d{2}\/\d{2}\/\d{4}$/.test(data)) return { erro: 'Data de início inválida (DD/MM/AAAA)' };
  return { valores: [String(b.nome ?? '').slice(0, 120), String(b.descricao ?? '').slice(0, 1000), valor_total, Number(prazo),
    rentabilidade, valor_inicial, data, valor_selado] };
}

app.post('/sonhos', auth(), (req, res) => {
  const c = camposSonho(req.body);
  if (c.erro) return res.status(400).json({ erro: c.erro });
  const r = db.prepare('INSERT INTO sonhos (usuario_id, nome, descricao, valor_total, prazo, rentabilidade, valor_inicial, data_inicio, valor_selado) VALUES (?,?,?,?,?,?,?,?,?)').run(req.user.id, ...c.valores);
  res.status(201).json(db.prepare('SELECT * FROM sonhos WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/sonhos/:id', auth(), (req, res) => {
  const c = camposSonho(req.body);
  if (c.erro) return res.status(400).json({ erro: c.erro });
  db.prepare('UPDATE sonhos SET nome=?, descricao=?, valor_total=?, prazo=?, rentabilidade=?, valor_inicial=?, data_inicio=?, valor_selado=? WHERE id=? AND usuario_id=?').run(...c.valores, req.params.id, req.user.id);
  const sonho = db.prepare('SELECT * FROM sonhos WHERE id = ? AND usuario_id = ?').get(req.params.id, req.user.id);
  if (!sonho) return res.status(404).json({ erro: 'Sonho não encontrado' });
  res.json(sonho);
});

app.delete('/sonhos/:id', auth(), (req, res) => {
  db.prepare('DELETE FROM sonhos WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── FIPE proxy ───────────────────────────────────────────────
const FIPE_BASE = 'https://parallelum.com.br/fipe/api/v1/carros';

app.get('/fipe/marcas', auth(), async (_req, res) => {
  try {
    const r = await fetch(`${FIPE_BASE}/marcas`);
    res.json(await r.json());
  } catch { res.status(502).json({ erro: 'FIPE indisponível' }); }
});

app.get('/fipe/marcas/:marca/modelos', auth(), async (req, res) => {
  try {
    const r = await fetch(`${FIPE_BASE}/marcas/${encodeURIComponent(req.params.marca)}/modelos`);
    res.json(await r.json());
  } catch { res.status(502).json({ erro: 'FIPE indisponível' }); }
});

app.get('/fipe/marcas/:marca/modelos/:modelo/anos', auth(), async (req, res) => {
  try {
    const r = await fetch(`${FIPE_BASE}/marcas/${encodeURIComponent(req.params.marca)}/modelos/${encodeURIComponent(req.params.modelo)}/anos`);
    res.json(await r.json());
  } catch { res.status(502).json({ erro: 'FIPE indisponível' }); }
});

app.get('/fipe/marcas/:marca/modelos/:modelo/anos/:ano', auth(), async (req, res) => {
  try {
    const r = await fetch(`${FIPE_BASE}/marcas/${encodeURIComponent(req.params.marca)}/modelos/${encodeURIComponent(req.params.modelo)}/anos/${encodeURIComponent(req.params.ano)}`);
    res.json(await r.json());
  } catch { res.status(502).json({ erro: 'FIPE indisponível' }); }
});

// Rota unificada: busca preço pelo nome da marca, modelo e ano
app.get('/fipe/buscar', auth(), async (req, res) => {
  const { marca, modelo, ano } = req.query;
  if (!marca || !modelo || !ano) return res.status(400).json({ erro: 'marca, modelo e ano obrigatórios' });
  try {
    const marcas = await (await fetch(`${FIPE_BASE}/marcas`)).json();
    const marcaObj = marcas.find(m => m.nome.toLowerCase().includes(String(marca).toLowerCase()));
    if (!marcaObj) return res.status(404).json({ erro: `Marca "${marca}" não encontrada` });

    const modelosResp = await (await fetch(`${FIPE_BASE}/marcas/${marcaObj.codigo}/modelos`)).json();
    const busca = String(modelo).toLowerCase();
    // Filtra modelos que contenham o texto; prefere o nome mais curto (versão mais simples)
    const candidatos = modelosResp.modelos
      .filter(m => m.nome.toLowerCase().includes(busca))
      .sort((a, b) => a.nome.length - b.nome.length);
    if (!candidatos.length) return res.status(404).json({ erro: `Modelo "${modelo}" não encontrado` });

    // Busca o preço de cada candidato e retorna a média dos que têm o ano certo (excluindo 0km)
    const anoStr = String(ano);
    const resultados = [];
    for (const modeloObj of candidatos.slice(0, 5)) {
      const anos = await (await fetch(`${FIPE_BASE}/marcas/${marcaObj.codigo}/modelos/${modeloObj.codigo}/anos`)).json();
      // Tenta primeiro sem 0km com o ano exato
      let anosValidos = anos.filter(a => !a.codigo.startsWith('32000') && a.nome.includes(anoStr));
      // Fallback 1: inclui 0km se não encontrou o ano
      if (!anosValidos.length) anosValidos = anos.filter(a => a.nome.includes(anoStr));
      // Fallback 2: usa qualquer ano disponível (sem 0km preferível)
      if (!anosValidos.length) anosValidos = anos.filter(a => !a.codigo.startsWith('32000')).slice(0, 1);
      if (!anosValidos.length) anosValidos = anos.slice(0, 1);
      for (const anoObj of anosValidos.slice(0, 2)) {
        const preco = await (await fetch(`${FIPE_BASE}/marcas/${marcaObj.codigo}/modelos/${modeloObj.codigo}/anos/${anoObj.codigo}`)).json();
        const valor = parseFloat(preco.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
        if (!isNaN(valor)) resultados.push({ valor, modelo: modeloObj.nome, ano: anoObj.nome });
      }
      if (resultados.length >= 3) break;
    }

    if (!resultados.length) return res.status(404).json({ erro: `Nenhum resultado para ${marca} ${modelo} ${ano}` });

    // Retorna a média dos valores encontrados
    const media = Math.round(resultados.reduce((s, r) => s + r.valor, 0) / resultados.length);
    res.json({ valor: media, modelo: resultados[0].modelo, ano: resultados[0].ano, marca: marcaObj.nome, variantes: resultados.length });
  } catch (e) {
    res.status(502).json({ erro: 'Erro ao consultar FIPE' });
  }
});

// ── IA: Estimativa de valor de carro ─────────────────────────
app.post('/ia/valor-carro', auth(), iaLimiter, async (req, res) => {
  const { modelo, ano } = req.body;
  if (!modelo || !ano) return res.status(400).json({ erro: 'modelo e ano obrigatórios' });
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: `Qual o valor médio de mercado no Brasil (em reais) de um ${modelo} ano ${ano}? Responda APENAS com o número inteiro, sem pontuação, sem texto, sem R$. Exemplo: 85000`
      }]
    });
    const texto = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    const valor = parseInt(texto.replace(/\D/g, ''), 10);
    if (isNaN(valor)) return res.status(422).json({ erro: 'não foi possível estimar' });
    res.json({ valor });
  } catch (e) {
    res.status(500).json({ erro: 'erro ao consultar IA' });
  }
});

// ── Gestão de Pagamentos: receitas lançadas, dívidas, investimentos e ajustes mês a mês ──
// Receitas: o usuário lança o que entrou em cada mês (a meta é a receita planejada em Recebimentos).
// Dívidas (PMT > 0, não quitadas), "Outras Dívidas" e a Meta de Investimento Mensal vêm previstas
// em todos os meses e podem ser ajustadas mês a mês; o ajuste fica em gestao_ajustes.
db.exec(`
  CREATE TABLE IF NOT EXISTS lancamentos_receitas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    valor REAL NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_lanc_receitas_usuario ON lancamentos_receitas(usuario_id, data);

  CREATE TABLE IF NOT EXISTS gestao_ajustes (
    usuario_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,          -- 'divida' | 'outras_dividas' | 'investimento'
    ref_id INTEGER NOT NULL DEFAULT 0,
    chave TEXT NOT NULL,         -- AAAA-MM
    valor REAL NOT NULL,
    PRIMARY KEY (usuario_id, tipo, ref_id, chave)
  );

  CREATE TABLE IF NOT EXISTS gestao_config (
    usuario_id INTEGER NOT NULL,
    chave TEXT NOT NULL,
    valor REAL NOT NULL,
    PRIMARY KEY (usuario_id, chave)
  );
`);

const TIPOS_AJUSTE = ['divida', 'outras_dividas', 'investimento'];
const chaveMesValida = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));

function dadosPagamentos(usuarioId, de, ate) {
  const receitas_realizadas = db.prepare(`
    SELECT substr(data, 1, 7) AS chave, SUM(valor) AS total, COUNT(*) AS quantidade
    FROM lancamentos_receitas WHERE usuario_id = ? AND substr(data, 1, 7) BETWEEN ? AND ?
    GROUP BY chave
  `).all(usuarioId, de, ate);
  const receita_planejada = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN classe LIKE 'Eventual%' THEN valor / 12.0 ELSE valor END), 0) AS t
    FROM recebimentos WHERE usuario_id = ?
  `).get(usuarioId).t;
  const dividas = db.prepare(`
    SELECT id, guia, nome, pmt, parcelas_totais, parcelas_restantes
    FROM dividas WHERE usuario_id = ? AND quitado = 0 AND pmt > 0 ORDER BY id
  `).all(usuarioId);
  const ajustes = db.prepare('SELECT tipo, ref_id, chave, valor FROM gestao_ajustes WHERE usuario_id = ? AND chave BETWEEN ? AND ?')
    .all(usuarioId, de, ate);
  const cfg = db.prepare("SELECT valor FROM gestao_config WHERE usuario_id = ? AND chave = 'outras_dividas_meta'").get(usuarioId);
  const sonhos = db.prepare('SELECT * FROM sonhos WHERE usuario_id = ? ORDER BY id').all(usuarioId);
  return {
    receitas_realizadas, receita_planejada: Math.round(receita_planejada * 100) / 100,
    dividas, ajustes, outras_dividas_meta: cfg ? cfg.valor : 0, sonhos,
  };
}

// Lançamentos de receita de um mês
app.get('/lancamentos-receitas', auth(), (req, res) => {
  if (!chaveMesValida(req.query.mes)) return res.status(400).json({ erro: 'Informe mes (AAAA-MM)' });
  res.json(db.prepare('SELECT * FROM lancamentos_receitas WHERE usuario_id = ? AND data LIKE ? ORDER BY data DESC, id DESC')
    .all(req.user.id, `${req.query.mes}%`));
});

app.post('/lancamentos-receitas', auth(), (req, res) => {
  const { data, valor, descricao } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return res.status(400).json({ erro: 'Data inválida (AAAA-MM-DD)' });
  const v = Math.round(Number(valor) * 100) / 100;
  if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero' });
  const r = db.prepare('INSERT INTO lancamentos_receitas (usuario_id, data, valor, descricao) VALUES (?, ?, ?, ?)')
    .run(req.user.id, data, v, String(descricao || '').trim());
  res.status(201).json(db.prepare('SELECT * FROM lancamentos_receitas WHERE id = ?').get(r.lastInsertRowid));
});

app.delete('/lancamentos-receitas/:id', auth(), (req, res) => {
  const r = db.prepare('DELETE FROM lancamentos_receitas WHERE id = ? AND usuario_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ erro: 'Lançamento não encontrado' });
  res.json({ ok: true });
});

// Ajuste de um mês (dívida, outras dívidas ou investimento). valor null/vazio volta ao previsto.
app.put('/gestao-ajustes', auth(), (req, res) => {
  const { tipo, ref_id, chave, valor } = req.body;
  if (!TIPOS_AJUSTE.includes(tipo)) return res.status(400).json({ erro: 'Tipo inválido' });
  if (!chaveMesValida(chave)) return res.status(400).json({ erro: 'Mês inválido (AAAA-MM)' });
  const ref = Number(ref_id) || 0;
  if (tipo === 'divida' && !db.prepare('SELECT 1 FROM dividas WHERE id = ? AND usuario_id = ?').get(ref, req.user.id)) {
    return res.status(404).json({ erro: 'Dívida não encontrada' });
  }
  if (valor === null || valor === undefined || valor === '') {
    db.prepare('DELETE FROM gestao_ajustes WHERE usuario_id = ? AND tipo = ? AND ref_id = ? AND chave = ?').run(req.user.id, tipo, ref, chave);
    return res.json({ ok: true, removido: true });
  }
  const v = Math.round(Number(valor) * 100) / 100;
  if (!Number.isFinite(v) || v < 0) return res.status(400).json({ erro: 'Valor inválido' });
  db.prepare(`INSERT INTO gestao_ajustes (usuario_id, tipo, ref_id, chave, valor) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(usuario_id, tipo, ref_id, chave) DO UPDATE SET valor = excluded.valor`).run(req.user.id, tipo, ref, chave, v);
  res.json({ ok: true });
});

// Meta mensal da linha "Outras Dívidas"
app.put('/gestao-config/outras-dividas-meta', auth(), (req, res) => {
  const v = Math.round(Number(req.body.valor || 0) * 100) / 100;
  if (!Number.isFinite(v) || v < 0) return res.status(400).json({ erro: 'Valor inválido' });
  db.prepare(`INSERT INTO gestao_config (usuario_id, chave, valor) VALUES (?, 'outras_dividas_meta', ?)
    ON CONFLICT(usuario_id, chave) DO UPDATE SET valor = excluded.valor`).run(req.user.id, v);
  res.json({ ok: true, valor: v });
});

// ── Dashboard: Grau de Comprometimento (GC) ──
// GC = X / renda mensal, onde
//   renda mensal = recebimentos Mensal Flexível + Mensal Comprometido
//   X = gastos Mensal Comprometido (meta mensal dos itens)
//     + PMT das dívidas não quitadas (passivos financeiros e imobilizados)
//     + Y: parcelas de compras parceladas que caem no mês seguinte (muda conforme os lançamentos)
function mesSeguinte() {
  const d = new Date();
  const s = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}`;
}

function grauComprometimento(usuarioId) {
  const soma = (sql, ...args) => Number(db.prepare(sql).get(...args).t) || 0;
  const renda = soma(`SELECT COALESCE(SUM(valor), 0) AS t FROM recebimentos
    WHERE usuario_id = ? AND classe IN ('Mensal Flexível', 'Mensal Comprometido')`, usuarioId);
  const gastosComprometidos = soma(`SELECT COALESCE(SUM(valor), 0) AS t FROM gastos
    WHERE usuario_id = ? AND classe = 'Mensal Comprometido' AND categoria <> ?`, usuarioId, CATEGORIA_NI);
  const passivosFinanceiros = soma(`SELECT COALESCE(SUM(pmt), 0) AS t FROM dividas
    WHERE usuario_id = ? AND quitado = 0 AND guia = 'financeiros'`, usuarioId);
  const passivosImobilizados = soma(`SELECT COALESCE(SUM(pmt), 0) AS t FROM dividas
    WHERE usuario_id = ? AND quitado = 0 AND guia = 'imobilizados'`, usuarioId);
  const mes = mesSeguinte();
  const parcelados = soma(`SELECT COALESCE(SUM(valor), 0) AS t FROM lancamentos_gastos
    WHERE usuario_id = ? AND repeticao = 'parcelado' AND substr(data, 1, 7) = ?`, usuarioId, mes);
  const x = gastosComprometidos + passivosFinanceiros + passivosImobilizados + parcelados;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    renda: r2(renda),
    gastos_comprometidos: r2(gastosComprometidos),
    passivos_financeiros: r2(passivosFinanceiros),
    passivos_imobilizados: r2(passivosImobilizados),
    parcelados_mes_seguinte: r2(parcelados),
    mes_parcelados: mes,
    comprometido: r2(x),
    percentual: renda > 0 ? Math.round((x / renda) * 1000) / 10 : null,
  };
}

// ── Dashboard: Nível de Saúde do Orçamento Familiar (1 a 9) ──
// M.I.M. de um sonho: mesma conta de src/app/shared/calculo-sonhos.ts (manter as duas iguais).
function parseDataSonho(str) {
  if (!str || str.length < 8) return null;
  const partes = str.includes('/') ? str.split('/') : str.split('-');
  if (partes.length !== 3) return null;
  const [a, b, c] = partes;
  return str.includes('-') ? new Date(+a, +b - 1, +c) : new Date(+c, +b - 1, +a);
}
function mimSonho(s, hoje = new Date()) {
  if (!s.valor_total) return 0;
  const prazo = s.prazo || 0;
  if (prazo <= 0) return 0;
  const r = (s.rentabilidade || 0) / 100;
  const d = parseDataSonho(s.data_inicio);
  let restantes = prazo;
  if (d) {
    const fim = new Date(d); fim.setMonth(fim.getMonth() + prazo);
    restantes = Math.max(0, (fim.getFullYear() - hoje.getFullYear()) * 12 + (fim.getMonth() - hoje.getMonth()));
  }
  const atual = s.valor_selado && s.valor_selado > 0 ? s.valor_selado : (s.valor_inicial || 0);
  const fvAtual = r > 0 ? atual * Math.pow(1 + r, restantes) : atual;
  const falta = s.valor_total - fvAtual;
  if (falta <= 0) return 0;
  if (r === 0) return falta / prazo;
  return Math.round(falta * r / (Math.pow(1 + r, prazo) - 1));
}

// Partes do orçamento mensal (valores mensais; eventuais = anual ÷ 12)
function componentesOrcamento(usuarioId) {
  const soma = (sql, ...args) => Number(db.prepare(sql).get(...args).t) || 0;
  const metaClasse = (classe, eventual) => soma(`SELECT COALESCE(SUM(valor), 0) AS t FROM gastos
    WHERE usuario_id = ? AND classe = ? AND categoria <> ?`, usuarioId, classe, CATEGORIA_NI) / (eventual ? 12 : 1);
  const pmt = (guia) => soma(`SELECT COALESCE(SUM(pmt), 0) AS t FROM dividas WHERE usuario_id = ? AND quitado = 0 AND guia = ?`, usuarioId, guia);
  const receitaMensal = soma(`SELECT COALESCE(SUM(valor), 0) AS t FROM recebimentos
    WHERE usuario_id = ? AND classe IN ('Mensal Flexível', 'Mensal Comprometido')`, usuarioId);
  const receitaEventual = soma(`SELECT COALESCE(SUM(valor), 0) AS t FROM recebimentos
    WHERE usuario_id = ? AND classe LIKE 'Eventual%'`, usuarioId) / 12;
  const mim = db.prepare('SELECT * FROM sonhos WHERE usuario_id = ?').all(usuarioId).reduce((t, s) => t + mimSonho(s), 0);
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    A: r2(pmt('imobilizados')),             // Passivo Patrimonial
    B: r2(pmt('financeiros')),              // Passivo Financeiro
    C: r2(metaClasse('Mensal Comprometido')),
    D: r2(metaClasse('Mensal Flexível')),
    E: r2(metaClasse('Eventual Flexível', true)),
    F: r2(metaClasse('Eventual Comprometido', true)),
    G: r2(mim),                             // M.I.M. (Sonhos)
    H: r2(receitaMensal),                   // Receita Mensal
    I: r2(receitaMensal + receitaEventual), // Receita Total
  };
}

// Árvore de decisão (regra da planilha, corrigida para não ter lacunas nem sobreposições):
//   W = A+B+C, K = W+D, V = K+E+F, S = V+G;  M = 97% de H, N = 103% de H
//   R = 1,2 × (I − H), U = 0,8 × (I − H)
//   1: W > N | 2: K > N | 3: V > N                 → a primeira etapa que estoura 103% da renda
//   4/5/6: M ≤ V ≤ N → eventuais (E+F) > R / entre U e R / < U
//   7/8/9: V < M     → S > N (não cabe o M.I.M.) / S < M (sobra sem destino) / M ≤ S ≤ N
function nivelSaude(c) {
  if (!(c.H > 0)) return { nivel: null, motivo: 'Sem receita mensal cadastrada' };
  const W = c.A + c.B + c.C, K = W + c.D, V = K + c.E + c.F, S = V + c.G;
  const M = c.H * 0.97, N = c.H * 1.03, R = 1.2 * (c.I - c.H), U = 0.8 * (c.I - c.H);
  const EF = c.E + c.F;
  const base = { W, K, V, S, M, N, R, U };
  if (W > N) return { ...base, nivel: 1, motivo: 'Passivos e gastos mensais comprometidos passam de 103% da receita mensal' };
  if (K > N) return { ...base, nivel: 2, motivo: 'Com os gastos mensais flexíveis, passa de 103% da receita mensal' };
  if (V > N) return { ...base, nivel: 3, motivo: 'Com os gastos eventuais, passa de 103% da receita mensal' };
  if (V >= M) {
    if (EF > R) return { ...base, nivel: 4, motivo: 'Gastos no limite da renda e eventuais acima de 120% da receita eventual' };
    if (EF >= U) return { ...base, nivel: 5, motivo: 'Gastos no limite da renda e eventuais entre 80% e 120% da receita eventual' };
    return { ...base, nivel: 6, motivo: 'Gastos no limite da renda e eventuais abaixo de 80% da receita eventual' };
  }
  if (S > N) return { ...base, nivel: 7, motivo: 'Gastos cabem na renda, mas o M.I.M. completo não cabe' };
  if (S < M) return { ...base, nivel: 8, motivo: 'Gastos e M.I.M. cabem, e sobra renda sem destino' };
  return { ...base, nivel: 9, motivo: 'Gastos e M.I.M. ocupam a renda de forma equilibrada' };
}

// ── Dashboard: Limite da Fatura do Cartão ──
// Soma dos valores mensais (eventuais = anual ÷ 12) de todos os gastos marcados como pagos no cartão.
function limiteCartao(usuarioId) {
  const t = db.prepare(`SELECT COALESCE(SUM(CASE WHEN classe LIKE 'Eventual%' THEN valor / 12.0 ELSE valor END), 0) AS t
    FROM gastos WHERE usuario_id = ? AND com_cartao = 1 AND categoria <> ?`).get(usuarioId, CATEGORIA_NI).t;
  return Math.round((Number(t) || 0) * 100) / 100;
}

// ── Dashboard: Base de Plena Liquidez (BPL), uma por pessoa ──
// BPL(A) = participação de A em todas as receitas (mensais + eventuais ÷ 12, a mesma Receita Total do orçamento)
//        × total de pagamentos (gastos mensalizados + PMT das dívidas; sem o M.I.M.) × Z(A) × W(A)
//   Z = peso do grau de risco de perda total da renda; W = peso da dificuldade de recuperar a mesma renda.
// A receita é de uma pessoa quando a "Origem" do recebimento é o primeiro nome dela.
// Com uma pessoa só cadastrada, a participação é sempre 100% (toda a renda da casa é dela, mesmo a
// sem origem ou com a origem de alguém excluído). Com duas, receita sem dono entra no total e não
// é de ninguém (regra mantida de propósito).
const PESO_RISCO_RENDA = { 'Muito Baixo': 1, 'Baixo': 2, 'Mediano': 3, 'Alto': 4, 'Muito Alto': 5 };
const PESO_FACILIDADE_RENDA = { 'Muito Fácil': 1, 'Fácil': 1.1, 'Razoável': 1.2, 'Difícil': 1.4, 'Muito Difícil': 1.5 };

function basePlenaLiquidez(usuarioId, c) {
  const pagamentos = c.A + c.B + c.C + c.D + c.E + c.F;
  const rendaPorOrigem = Object.fromEntries(db.prepare(`SELECT origem,
      COALESCE(SUM(CASE WHEN classe LIKE 'Eventual%' THEN valor / 12.0 ELSE valor END), 0) AS t
    FROM recebimentos WHERE usuario_id = ? AND classe <> '' GROUP BY origem`).all(usuarioId)
    .map((r) => [r.origem, Number(r.t) || 0]));
  // total sem arredondar (inclui recebimentos sem origem), para a proporção não perder centavos
  const totalReceitas = Object.values(rendaPorOrigem).reduce((t, v) => t + v, 0);
  const r2 = (v) => Math.round(v * 100) / 100;
  const pessoas = db.prepare('SELECT nome, risco_renda, facilidade_renda FROM pessoas WHERE usuario_id = ? ORDER BY id').all(usuarioId);
  return pessoas
    .map((p) => {
      const renda = rendaPorOrigem[p.nome.trim().split(/\s+/)[0]] || 0;
      const participacao = pessoas.length === 1 ? 1 : totalReceitas > 0 ? renda / totalReceitas : 0;
      const z = PESO_RISCO_RENDA[p.risco_renda] ?? null;
      const w = PESO_FACILIDADE_RENDA[p.facilidade_renda] ?? null;
      const faltando = [!z && 'grau de risco de perda da renda', !w && 'facilidade de recuperar a renda'].filter(Boolean);
      return {
        nome: p.nome, renda: r2(renda), participacao: Math.round(participacao * 1000) / 10,
        pagamentos: r2(pagamentos), peso_risco: z, peso_facilidade: w, faltando,
        valor: z && w ? r2(participacao * pagamentos * z * w) : 0,
      };
    });
}

// Pré-preenchimento do formulário "Contrate um planejador" (o usuário pode editar tudo na tela).
// Estado civil: 2 pessoas cadastradas = casal. Investimentos: só "Sim" quando há ativo financeiro com
// valor; sem isso fica em branco (a tela de Ativos pode não ter sido preenchida).
app.get('/perfil/diagnostico', auth(), (req, res) => {
  const pessoas = db.prepare('SELECT COUNT(*) AS n FROM pessoas WHERE usuario_id = ?').get(req.user.id).n;
  const investe = db.prepare("SELECT 1 FROM ativos WHERE usuario_id = ? AND guia = 'financeiros' AND valor_atual > 0 LIMIT 1").get(req.user.id);
  const titular = db.prepare('SELECT nome FROM pessoas WHERE usuario_id = ? ORDER BY id LIMIT 1').get(req.user.id);
  res.json({
    nome: titular?.nome || req.user.nome || '',
    estado_civil: pessoas >= 2 ? 'casado' : pessoas === 1 ? 'solteiro' : '',
    renda_mensal: Math.round(componentesOrcamento(req.user.id).H || 0),
    investimentos: investe ? 'sim' : '',
    profissao: '',
  });
});

app.get('/dashboard', auth(), (req, res) => {
  const componentes = componentesOrcamento(req.user.id);
  res.json({
    base_plena_liquidez: basePlenaLiquidez(req.user.id, componentes),
    limite_cartao: limiteCartao(req.user.id),
    grau_comprometimento: grauComprometimento(req.user.id),
    nivel_saude: { ...nivelSaude(componentes), componentes },
  });
});

// ── Avisos (agendador + histórico) ─────────────────────────
// De hora em hora (a partir das 8h, horário de Brasília) o agendador olha o calendário de cada
// usuário e registra os avisos do dia: contas a vencer, fechamento/vencimento da fatura, melhor dia
// de compra no cartão, meta perto do limite e o "quanto ainda posso gastar" programado — conforme a
// configuração de cada um no menu Alertas. A chave única impede repetir o mesmo aviso. O envio pelo
// WhatsApp é feito pelo integrador, que busca a fila de saída (ver whatsapp.js); sem integração o
// aviso fica registrado como 'sem_canal' e aparece só no histórico do app.
db.exec(`
  CREATE TABLE IF NOT EXISTS avisos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,          -- conta_vencendo | fatura_fecha | melhor_dia_compra | fatura_vence
    chave TEXT NOT NULL,         -- identifica o aviso (tipo + item + data); evita duplicar
    data_ref TEXT NOT NULL,      -- AAAA-MM-DD do vencimento/fechamento a que se refere
    titulo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    canal TEXT NOT NULL DEFAULT 'whatsapp',
    destino TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | falhou | sem_canal | sem_destino
    erro TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    enviado_em DATETIME,
    UNIQUE (usuario_id, chave)
  );
  CREATE INDEX IF NOT EXISTS idx_avisos_usuario ON avisos(usuario_id, criado_em);
`);

// WhatsApp: entrada de mensagens, consultas, alertas configuráveis e fila de saída (ver whatsapp.js)
const wpp = require('./whatsapp')({ iaLimiter,
  app, db, auth, interpretarMensagem, identificarItem, dividirEmParcelas, somarMeses,
  CATEGORIA_NI, agoraBrasilia, normalizarTexto,
});

const FUSO_AVISOS = 'America/Sao_Paulo';
const HORA_INICIO_AVISOS = 8;
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Data e hora de agora no fuso de Brasília (independe do fuso do servidor)
function agoraBrasilia() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_AVISOS, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { hoje: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}

// Datas como AAAA-MM-DD, calculadas em UTC para não sofrer com horário de verão
const dataUtc = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
const isoUtc = (dt) => dt.toISOString().slice(0, 10);
const diasEntre = (de, ate) => Math.round((dataUtc(ate) - dataUtc(de)) / 86400000);
const somarDias = (iso, n) => { const d = dataUtc(iso); d.setUTCDate(d.getUTCDate() + n); return isoUtc(d); };
const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // mes 1..12
// Dia 31 em mês curto cai no último dia do mês
const dataNoMes = (ano, mes, dia) => isoUtc(new Date(Date.UTC(ano, mes - 1, Math.min(dia, ultimoDia(ano, mes)))));

// Próxima ocorrência (hoje inclusive) de um dia mensal, ou de dia/mês anual
function proximaData(hoje, dia, mes = null) {
  const [a, m] = hoje.split('-').map(Number);
  if (mes) {
    const esteAno = dataNoMes(a, mes, dia);
    return esteAno >= hoje ? esteAno : dataNoMes(a + 1, mes, dia);
  }
  const esteMes = dataNoMes(a, m, dia);
  if (esteMes >= hoje) return esteMes;
  return m === 12 ? dataNoMes(a + 1, 1, dia) : dataNoMes(a, m + 1, dia);
}

// Vencimento da fatura que fecha em `fechamento` (o primeiro dia de vencimento depois do fechamento)
const vencimentoAposFechamento = (fechamento, diaVenc) => proximaData(somarDias(fechamento, 1), diaVenc);

const dataCurta = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}/${MESES_CURTOS[m - 1]}`; };
const reais = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

// Avisos devidos hoje para um usuário (sem gravar nada). Respeita a configuração de cada alerta
// (menu Alertas): ligado/desligado e com quantos dias de antecedência.
function avisosDoDia(usuarioId, hoje, cfg = wpp.configAlertas(usuarioId)) {
  const avisos = [];
  const novo = (tipo, chave, dataRef, titulo, mensagem, variaveis = {}) => {
    if (cfg[tipo]?.ativo) avisos.push({ tipo, chave, data_ref: dataRef, titulo, mensagem, variaveis });
  };
  const antecedencias = (tipo) => [].concat(cfg[tipo]?.parametros?.dias_antes ?? []);

  // Contas mensais com dia fixo (fora do cartão): 3 dias antes e no dia
  const mensais = db.prepare(`SELECT id, descricao, valor, dia_vencimento FROM gastos
    WHERE usuario_id = ? AND com_cartao = 0 AND classe = 'Mensal Comprometido' AND dia_vencimento IS NOT NULL`).all(usuarioId);
  for (const c of mensais) {
    const venc = proximaData(hoje, c.dia_vencimento);
    const faltam = diasEntre(hoje, venc);
    const nome = c.descricao || 'Conta sem nome';
    const valor = c.valor > 0 ? ` (previsto ${reais(c.valor)})` : '';
    const vars = { conta: nome, vencimento: dataCurta(venc), valor: c.valor > 0 ? reais(c.valor) : 'não informado',
      quando: faltam === 0 ? 'hoje' : `em ${faltam} dia${faltam > 1 ? 's' : ''}, ${dataCurta(venc)}` };
    if (!antecedencias('conta_vencendo').includes(faltam)) continue;
    if (faltam === 0) novo('conta_vencendo', `conta:${c.id}:${venc}:D0`, venc, `${nome} vence hoje`, `📅 ${nome} vence hoje${valor}.`, vars);
    else novo('conta_vencendo', `conta:${c.id}:${venc}:D${faltam}`, venc, `${nome} vence em ${faltam} dia${faltam > 1 ? 's' : ''}`,
      `📅 ${nome} vence em ${faltam} dia${faltam > 1 ? 's' : ''}, ${dataCurta(venc)}${valor}.`, vars);
  }

  // Contas eventuais com mês fixo (uma vez por ano, fora do cartão): dia 1º do mês anterior e do próprio mês
  const [anoHoje, mesHoje, diaHoje] = hoje.split('-').map(Number);
  if (diaHoje === 1) {
    const eventuais = db.prepare(`SELECT id, descricao, valor, mes_vencimento FROM gastos
      WHERE usuario_id = ? AND com_cartao = 0 AND classe = 'Eventual Comprometido' AND mes_vencimento IS NOT NULL`).all(usuarioId);
    const mesSeguinte = mesHoje === 12 ? 1 : mesHoje + 1;
    for (const c of eventuais) {
      const nome = c.descricao || 'Conta sem nome';
      const valor = c.valor > 0 ? ` (previsto ${reais(c.valor)})` : '';
      if (c.mes_vencimento === mesHoje) {
        novo('conta_vencendo', `anual:${c.id}:${anoHoje}-${String(mesHoje).padStart(2, '0')}:M0`, hoje,
          `${nome} vence este mês`, `🗓️ ${nome} vence este mês, em ${MESES_LONGOS[mesHoje - 1]}${valor}.`,
          { conta: nome, vencimento: MESES_LONGOS[mesHoje - 1], quando: `este mês, em ${MESES_LONGOS[mesHoje - 1]}`, valor: c.valor > 0 ? reais(c.valor) : 'não informado' });
      } else if (c.mes_vencimento === mesSeguinte) {
        const anoVenc = mesSeguinte === 1 ? anoHoje + 1 : anoHoje;
        novo('conta_vencendo', `anual:${c.id}:${anoVenc}-${String(mesSeguinte).padStart(2, '0')}:M1`, hoje,
          `${nome} vence no mês que vem`, `🗓️ ${nome} vence no mês que vem, em ${MESES_LONGOS[mesSeguinte - 1]}${valor}. Confira se o valor já está separado.`,
          { conta: nome, vencimento: MESES_LONGOS[mesSeguinte - 1], quando: `no mês que vem, em ${MESES_LONGOS[mesSeguinte - 1]}`, valor: c.valor > 0 ? reais(c.valor) : 'não informado' });
      }
    }
  }

  // Cartões: véspera do fechamento, melhor dia de compra (dia seguinte ao fechamento) e vencimento
  const cartoes = db.prepare(`SELECT id, nome, dia_fechamento, dia_vencimento FROM cartoes
    WHERE usuario_id = ? AND dia_fechamento IS NOT NULL`).all(usuarioId);
  for (const c of cartoes) {
    const fechamento = proximaData(hoje, c.dia_fechamento);
    const faltamFecha = diasEntre(hoje, fechamento);
    if (antecedencias('fatura_fecha').includes(faltamFecha)) {
      const quando = faltamFecha === 0 ? 'hoje' : faltamFecha === 1 ? 'amanhã' : `em ${faltamFecha} dias`;
      novo('fatura_fecha', `fecha:${c.id}:${fechamento}`, fechamento, `Fatura do ${c.nome} fecha ${quando}`,
        `💳 A fatura do ${c.nome} fecha ${quando} (${dataCurta(fechamento)}). Compras feitas depois do fechamento só entram na fatura seguinte.`,
        { cartao: c.nome, fechamento: dataCurta(fechamento), quando });
    }
    // Ontem foi o fechamento: hoje começa a fatura nova, a compra só é paga no vencimento seguinte
    const fechouOntem = somarDias(hoje, -1);
    if (proximaData(fechouOntem, c.dia_fechamento) === fechouOntem) {
      const paga = c.dia_vencimento ? vencimentoAposFechamento(proximaData(somarDias(hoje, 1), c.dia_fechamento), c.dia_vencimento) : null;
      novo('melhor_dia_compra', `compra:${c.id}:${hoje}`, hoje, `Melhor dia para comprar no ${c.nome}`,
        `🛍️ Hoje é o melhor dia para comprar no ${c.nome}: a fatura acabou de fechar${paga ? `, então a compra só será paga em ${dataCurta(paga)}` : ''}.`,
        { cartao: c.nome, pagamento: paga ? dataCurta(paga) : 'o vencimento da próxima fatura' });
    }
  }
  for (const c of db.prepare(`SELECT id, nome, dia_vencimento FROM cartoes WHERE usuario_id = ? AND dia_vencimento IS NOT NULL`).all(usuarioId)) {
    const venc = proximaData(hoje, c.dia_vencimento);
    const faltam = diasEntre(hoje, venc);
    if (!antecedencias('fatura_vence').includes(faltam)) continue;
    const vars = { cartao: c.nome, vencimento: dataCurta(venc), quando: faltam === 0 ? 'hoje' : `em ${faltam} dia${faltam > 1 ? 's' : ''}, ${dataCurta(venc)}` };
    if (faltam === 0) novo('fatura_vence', `vence:${c.id}:${venc}:D0`, venc, `Fatura do ${c.nome} vence hoje`, `💳 A fatura do ${c.nome} vence hoje.`, vars);
    else novo('fatura_vence', `vence:${c.id}:${venc}:D${faltam}`, venc, `Fatura do ${c.nome} vence em ${faltam} dia${faltam > 1 ? 's' : ''}`,
      `💳 A fatura do ${c.nome} vence em ${faltam} dia${faltam > 1 ? 's' : ''}, ${dataCurta(venc)}.`, vars);
  }
  return avisos;
}

// Gera e grava (sem repetir) os avisos de hoje: um por pessoa que recebe o alerta. Com a integração do
// WhatsApp ligada eles entram na fila de saída ('pendente'); sem ela ficam só registrados ('sem_canal').
// Devolve só os criados agora.
async function processarAvisos(hoje, usuarioId = null, hora = agoraBrasilia().hora) {
  const usuarios = usuarioId ? [{ id: usuarioId }] : db.prepare('SELECT id FROM usuarios').all();
  const criados = [];
  for (const u of usuarios) {
    const cfg = wpp.configAlertas(u.id);
    const avisos = [...avisosDoDia(u.id, hoje, cfg), ...wpp.avisosConfiguraveis(u.id, hoje, hora, cfg)];
    for (const a of avisos) criados.push(...wpp.gravarAviso(u.id, cfg[a.tipo], a));
  }
  return criados;
}

async function rodarAgendadorAvisos() {
  const { hoje, hora } = agoraBrasilia();
  if (hora < HORA_INICIO_AVISOS) return;
  try {
    const criados = await processarAvisos(hoje, null, hora);
    if (criados.length) console.log(`[avisos] ${criados.length} aviso(s) registrado(s) em ${hoje}`);
  } catch (e) { console.error('[avisos] falha no agendador:', e); }
}
setTimeout(rodarAgendadorAvisos, 5000);
setInterval(rodarAgendadorAvisos, 60 * 60 * 1000);

// Histórico do usuário (menu Alertas)
app.get('/avisos', auth(), (req, res) => {
  const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 50));
  res.json(db.prepare(`SELECT a.*, p.nome AS pessoa FROM avisos a LEFT JOIN pessoas p ON p.id = a.pessoa_id
    WHERE a.usuario_id = ? ORDER BY a.criado_em DESC, a.id DESC LIMIT ?`).all(req.user.id, limite).map(({ destino, ...a }) => a));
});

// Só desenvolvimento: simula o agendador numa data qualquer (?hoje=AAAA-MM-DD) para o usuário logado
if (process.env.DEV_SEM_LOGIN === '1') {
  app.post('/avisos/simular', auth(), async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local) return res.status(403).json({ erro: 'Disponível só localmente' });
    const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.hoje || '')) ? req.query.hoje : agoraBrasilia().hoje;
    const hora = Number.isInteger(Number(req.query.hora)) ? Number(req.query.hora) : agoraBrasilia().hora;
    const cfg = wpp.configAlertas(req.user.id);
    const previstos = [...avisosDoDia(req.user.id, hoje, cfg), ...wpp.avisosConfiguraveis(req.user.id, hoje, hora, cfg)];
    const criados = req.query.gravar === '1' ? await processarAvisos(hoje, req.user.id, hora) : [];
    res.json({ hoje, previstos, criados });
  });
}

// Área master (clientes, anúncios e avisos), assinaturas e convites — ver admin.js, pagamentos.js e convites.js
const adm = require('./admin')({ app, db, auth, componentesOrcamento, nivelSaude, grauComprometimento, agoraBrasilia, DATA_DIR });
const pagamentos = require('./pagamentos')({ app, db, auth, master: adm.master, agoraBrasilia, dividirEmParcelas, somarMeses });
adm.definirTemAssinatura(pagamentos.temAssinatura);
convites = require('./convites')({ app, db, master: adm.master, enviarEmail, FRONTEND_URL, escaparHtml, normalizarEmail, loginLimiter });

app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
