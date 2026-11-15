// ── Convites: quem convida informa o e-mail e o convidado recebe um link para se cadastrar ──
//
// O link leva a /cadastro?convite=<token>. Quem se cadastra pelo convite já entra com o e-mail
// confirmado (o link chegou nesse e-mail) e cai direto no app. O cadastro aberto continua igual.
//
// Três tipos de convite:
//   - cliente do master        (tipo 'cliente', planejador_id NULL)  → menu master "Enviar convite"
//   - planejador financeiro    (tipo 'planejador', com CPF/telefone) → menu master "Planejadores"
//   - cliente de um planejador (tipo 'cliente', planejador_id = id)  → área do planejador (ver planejadores.js)

const crypto = require('crypto');
const { cifrar, decifrar } = require('./cripto');

const DIAS_VALIDADE = 30;

// CPF com dígitos verificadores; telefone com DDD (10 ou 11 dígitos, aceita o 55 na frente)
function cpfValido(v) {
  const c = String(v || '').replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== Number(c[n])) return false;
  }
  return true;
}
function telefoneNormalizado(v) {
  let t = String(v || '').replace(/\D/g, '');
  if (t.length >= 12 && t.startsWith('55')) t = t.slice(2);
  return t.length === 10 || t.length === 11 ? t : null;
}

module.exports = function registrarConvites(ctx) {
  const { app, db, master, enviarEmail, FRONTEND_URL, escaparHtml, normalizarEmail, loginLimiter } = ctx;

  db.exec(`
    CREATE TABLE IF NOT EXISTS convites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      nome TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL UNIQUE,
      criado_por INTEGER,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      expira_em DATETIME NOT NULL,
      enviado_em DATETIME,            -- último envio por e-mail que deu certo
      erro_envio TEXT,                -- motivo do último envio que falhou
      usado_em DATETIME,
      usuario_id INTEGER,             -- conta criada pelo convite
      cancelado_em DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_convites_email ON convites(email);
  `);
  try { db.prepare("ALTER TABLE convites ADD COLUMN tipo TEXT NOT NULL DEFAULT 'cliente'").run(); } catch {}
  try { db.prepare('ALTER TABLE convites ADD COLUMN planejador_id INTEGER').run(); } catch {} // cliente convidado por um planejador
  try { db.prepare('ALTER TABLE convites ADD COLUMN cpf TEXT').run(); } catch {}              // planejador (cifrado)
  try { db.prepare('ALTER TABLE convites ADD COLUMN telefone TEXT').run(); } catch {}         // planejador (cifrado)

  const EMAIL_OK = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i; // mesmo formato do cadastro (server.js)
  const link = (token) => `${FRONTEND_URL}/cadastro?convite=${token}`;
  const novaValidade = () => `datetime('now', '+${DIAS_VALIDADE} days')`;
  const nomeDe = (id) => (id ? db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(id)?.nome || '' : '');

  function situacao(c) {
    if (c.usado_em) return 'aceito';
    if (c.cancelado_em) return 'cancelado';
    if (c.expira_em <= db.prepare("SELECT datetime('now') AS agora").get().agora) return 'expirado';
    return 'pendente';
  }
  const resumo = (c) => ({
    id: c.id, email: c.email, nome: c.nome, tipo: c.tipo, criado_em: c.criado_em, expira_em: c.expira_em,
    enviado_em: c.enviado_em, erro_envio: c.erro_envio, usado_em: c.usado_em, usuario_id: c.usuario_id,
    planejador_id: c.planejador_id, planejador_nome: nomeDe(c.planejador_id),
    ...(c.tipo === 'planejador' ? { cpf: decifrar(c.cpf), telefone: decifrar(c.telefone) } : {}),
    situacao: situacao(c), link: situacao(c) === 'pendente' ? link(c.token) : null,
  });

  async function enviar(c) {
    const ola = c.nome ? `Olá, ${escaparHtml(c.nome)}!` : 'Olá!';
    const planejador = nomeDe(c.planejador_id);
    const texto = c.tipo === 'planejador'
      ? 'Você foi convidado(a) para ser Planejador(a) Financeiro(a) parceiro(a) do Zevem. Crie sua conta pelo botão abaixo e comece a convidar seus clientes.'
      : planejador
        ? `${escaparHtml(planejador)}, seu planejador financeiro, convidou você para o Zevem, o seu planejamento financeiro guiado. Crie sua conta pelo botão abaixo.`
        : 'Você foi convidado(a) para o Zevem, o seu planejamento financeiro guiado. Crie sua conta pelo botão abaixo.';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
        <div style="background:#05261a;border-radius:14px;padding:32px;text-align:center;">
          <div style="font-size:22px;font-weight:600;letter-spacing:-0.4px;margin-bottom:16px;">
            <span style="color:#f7f8f5;">ze</span><span style="color:#b8f15a;">vem</span></div>
          <h2 style="color:#f7f8f5;margin:0 0 8px;">${ola}</h2>
          <p style="color:#a8bcb0;font-size:14px;line-height:1.6;margin:0 0 24px;">${texto}</p>
          <a href="${link(c.token)}" style="display:inline-block;background:#b8f15a;color:#05261a;
            padding:14px 32px;border-radius:10px;font-weight:800;text-decoration:none;font-size:14px;">
            Criar minha conta
          </a>
          <p style="color:#a8bcb0;font-size:12px;margin:20px 0 0;">O convite vale por ${DIAS_VALIDADE} dias.</p>
        </div>
      </div>`;
    const assunto = c.tipo === 'planejador' ? 'Seu convite de planejador no Zevem' : 'Seu convite para o Zevem';
    try {
      await enviarEmail(c.email, assunto, html);
      db.prepare('UPDATE convites SET enviado_em = CURRENT_TIMESTAMP, erro_envio = NULL WHERE id = ?').run(c.id);
      return null;
    } catch (e) {
      db.prepare('UPDATE convites SET erro_envio = ? WHERE id = ?').run(String(e.message || e).slice(0, 300), c.id);
      return `Convite criado, mas o e-mail não saiu (${e.message}). Copie o link e mande ao convidado.`;
    }
  }

  const porId = (id) => db.prepare('SELECT * FROM convites WHERE id = ?').get(id);
  const temConta = (email) => !!db.prepare('SELECT 1 FROM usuarios WHERE lower(trim(email)) = ?').get(email);

  // Cria o convite e manda o e-mail. Devolve { status, corpo } para a rota responder.
  async function criar({ email: bruto, nome: nomeBruto, tipo = 'cliente', planejadorId = null, cpf = null, telefone = null, criadoPor }) {
    const email = normalizarEmail(bruto);
    const nome = String(nomeBruto || '').trim().slice(0, 100);
    if (!EMAIL_OK.test(email)) return { status: 400, corpo: { erro: 'Informe um e-mail válido.' } };
    if (tipo === 'planejador') {
      if (!nome) return { status: 400, corpo: { erro: 'Informe o nome completo do planejador.' } };
      if (!cpfValido(cpf)) return { status: 400, corpo: { erro: 'CPF inválido.' } };
      if (!telefoneNormalizado(telefone)) return { status: 400, corpo: { erro: 'Informe o telefone com DDD.' } };
    }
    if (temConta(email)) return { status: 409, corpo: { erro: 'Este e-mail já tem conta no Zevem.' } };
    // Um convite em aberto por e-mail: o novo substitui os anteriores. O master (convite do Zevem)
    // substitui qualquer um; o planejador só os próprios, nunca o convite do master ou de outro planejador.
    const emAberto = "email = ? AND usado_em IS NULL AND cancelado_em IS NULL AND expira_em > datetime('now')";
    if (planejadorId && db.prepare(`SELECT 1 FROM convites WHERE ${emAberto} AND planejador_id IS NOT ?`).get(email, planejadorId)) {
      return { status: 409, corpo: { erro: 'Já existe um convite em aberto para este e-mail.' } };
    }
    db.prepare(`UPDATE convites SET cancelado_em = CURRENT_TIMESTAMP WHERE email = ? AND usado_em IS NULL AND cancelado_em IS NULL${planejadorId ? ' AND planejador_id = ?' : ''}`)
      .run(...(planejadorId ? [email, planejadorId] : [email]));
    const token = crypto.randomBytes(24).toString('hex');
    const r = db.prepare(`INSERT INTO convites (email, nome, token, criado_por, expira_em, tipo, planejador_id, cpf, telefone)
      VALUES (?, ?, ?, ?, ${novaValidade()}, ?, ?, ?, ?)`).run(email, nome, token, criadoPor, tipo, planejadorId,
      tipo === 'planejador' ? cifrar(String(cpf).replace(/\D/g, '')) : null,
      tipo === 'planejador' ? cifrar(telefoneNormalizado(telefone)) : null);
    const aviso = await enviar(porId(r.lastInsertRowid));
    return { status: 201, corpo: { ...resumo(porId(r.lastInsertRowid)), aviso_email: aviso } };
  }

  async function reenviar(c) {
    if (!c) return { status: 404, corpo: { erro: 'Convite não encontrado.' } };
    if (c.usado_em) return { status: 400, corpo: { erro: 'Este convite já foi usado.' } };
    if (temConta(c.email)) return { status: 409, corpo: { erro: 'Este e-mail já tem conta no Zevem.' } };
    // Reenviar reabre e renova a validade
    db.prepare(`UPDATE convites SET cancelado_em = NULL, expira_em = ${novaValidade()} WHERE id = ?`).run(c.id);
    const aviso = await enviar(porId(c.id));
    return { status: 200, corpo: { ...resumo(porId(c.id)), aviso_email: aviso } };
  }

  function cancelar(c) {
    if (!c) return { status: 404, corpo: { erro: 'Convite não encontrado.' } };
    if (c.usado_em) return { status: 400, corpo: { erro: 'Este convite já foi usado.' } };
    db.prepare('UPDATE convites SET cancelado_em = CURRENT_TIMESTAMP WHERE id = ?').run(c.id);
    return { status: 200, corpo: resumo(porId(c.id)) };
  }

  // ── Master: convites de clientes (os de planejadores aparecem no menu Planejadores) ──
  app.get('/admin/convites', master(), (req, res) => {
    const tipo = req.query.tipo === 'planejador' ? 'planejador' : 'cliente';
    res.json(db.prepare('SELECT * FROM convites WHERE tipo = ? ORDER BY id DESC LIMIT 300').all(tipo).map(resumo));
  });

  app.post('/admin/convites', master(), async (req, res) => {
    const r = await criar({ email: req.body?.email, nome: req.body?.nome, criadoPor: req.user.id });
    res.status(r.status).json(r.corpo);
  });

  app.post('/admin/convites/:id/reenviar', master(), async (req, res) => {
    const r = await reenviar(porId(Number(req.params.id)));
    res.status(r.status).json(r.corpo);
  });

  app.post('/admin/convites/:id/cancelar', master(), (req, res) => {
    const r = cancelar(porId(Number(req.params.id)));
    res.status(r.status).json(r.corpo);
  });

  // ── Público: a tela de cadastro consulta o convite para preencher os campos ──
  function buscarValido(token) {
    if (!token || typeof token !== 'string') return null;
    const c = db.prepare('SELECT * FROM convites WHERE token = ?').get(token);
    if (!c || situacao(c) !== 'pendente') return null;
    // Convite de um planejador que perdeu o acesso não vale mais
    if (c.planejador_id && db.prepare("SELECT 1 FROM usuarios WHERE id = ? AND (bloqueado_em IS NOT NULL OR papel != 'planejador')").get(c.planejador_id)) return null;
    return c;
  }

  app.get('/convites/:token', loginLimiter, (req, res) => {
    const c = buscarValido(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Este convite não vale mais. Peça um novo a quem te convidou.' });
    res.json({
      email: c.email, nome: c.nome, tipo: c.tipo, planejador: nomeDe(c.planejador_id),
      ...(c.tipo === 'planejador' ? { cpf: decifrar(c.cpf), telefone: decifrar(c.telefone) } : {}),
    });
  });

  // Antes de criar a conta: o planejador confirma (ou corrige) CPF e telefone
  function dadosCadastro(c, body) {
    if (c.tipo !== 'planejador') return {};
    const cpf = String(body?.cpf ?? decifrar(c.cpf)).replace(/\D/g, '');
    const telefone = telefoneNormalizado(body?.telefone ?? decifrar(c.telefone));
    if (!cpfValido(cpf)) return { erro: 'CPF inválido.' };
    if (!telefone) return { erro: 'Informe o telefone com DDD.' };
    return { cpf, telefone };
  }

  // Depois de criar a conta: papel de planejador ou vínculo do cliente com o planejador
  function aplicar(c, usuarioId, dados) {
    db.transaction(() => {
      db.prepare('UPDATE convites SET usado_em = CURRENT_TIMESTAMP, usuario_id = ? WHERE id = ?').run(usuarioId, c.id);
      if (c.tipo === 'planejador') {
        db.prepare("UPDATE usuarios SET papel = 'planejador' WHERE id = ?").run(usuarioId);
        db.prepare(`INSERT INTO planejadores (usuario_id, cpf, telefone, criado_por) VALUES (?, ?, ?, ?)
          ON CONFLICT(usuario_id) DO UPDATE SET cpf = excluded.cpf, telefone = excluded.telefone`)
          .run(usuarioId, cifrar(dados.cpf), cifrar(dados.telefone), c.criado_por);
      } else if (c.planejador_id) {
        db.prepare('UPDATE usuarios SET planejador_id = ? WHERE id = ?').run(c.planejador_id, usuarioId);
      }
    })();
  }

  return { buscarValido, dadosCadastro, aplicar, criar, reenviar, cancelar, porId, resumo, cpfValido, telefoneNormalizado };
};
