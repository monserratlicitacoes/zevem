// ── Área master: clientes, anúncio do planejador, avisos de acesso e vídeos assistidos ──
//
// Master = usuário com papel 'master'. Quem entra nesse papel: os e-mails de MASTER_EMAILS
// (separados por vírgula), sincronizados toda vez que o servidor sobe. Rotas /admin/* exigem master.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decifrar } = require('./cripto');

// Anúncio "Contrate um planejador": valores de partida (o master edita no menu Anúncios e avisos)
const ANUNCIO_PADRAO = {
  ativo: true,
  botao_menu: 'Contrate um planejador',
  selo: 'Planejador Financeiro Pessoal',
  titulo: 'Conquiste qualidade de vida no presente e no futuro com um Planejador Financeiro Pessoal',
  pontos: [
    { titulo: 'Sem conflito de interesse', texto: 'Ele só é remunerado por você. Por isso cuida do seu interesse, e não do próprio bolso.' },
    { titulo: 'Planejamento prático', texto: 'Ele monta um projeto simples e objetivo da sua vida financeira completa.' },
    { titulo: 'Orçamento e investimento', texto: 'Ele é o seu guia para organizar o orçamento e montar sua carteira de investimentos.' },
  ],
  destaque: 'Agende uma reunião de diagnóstico financeiro grátis!',
  botao_agendar: 'Agendar diagnóstico grátis',
  whatsapp: '5562998841299',
  mensagem: 'Olá, me chamo {nome} e gostaria de agendar minha reunião grátis de diagnóstico financeiro com um planejador financeiro.',
  foto_url: '',
  // Cores (chaves da paleta da marca, ver CORES_ANUNCIO em src/app/services/anuncio.service.ts)
  cor_botao_menu: 'lima',
  cor_destaque: 'lima',
  cor_botao_agendar: 'lima',
};
const CORES_ANUNCIO = ['lima', 'rosa', 'floresta', 'profundo', 'lima_claro', 'off_white'];

const PUBLICOS = ['todos', 'assinantes', 'nao_assinantes'];

// Vídeo de boas-vindas: abre no primeiro acesso do cliente e só libera o app quando o vídeo termina.
// O link de partida é o mesmo vídeo de teste dos painéis (src/app/shared/video-panel/videos-etapas.ts).
const BOAS_VINDAS_PADRAO = {
  ativo: true,
  link: 'https://www.youtube.com/watch?v=nLd6h5td8G4',
  titulo: 'Bem-vindo(a) ao Zevem!',
  botao: 'HORA DE CONSTRUIR MEU PLANEJAMENTO!',
};
const ID_YOUTUBE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;

module.exports = function registrarAdmin(ctx) {
  const { app, db, auth, componentesOrcamento, nivelSaude, grauComprometimento, agoraBrasilia, DATA_DIR } = ctx;

  // ── Tabelas e colunas ──
  try { db.prepare("ALTER TABLE usuarios ADD COLUMN papel TEXT NOT NULL DEFAULT 'cliente'").run(); } catch {}
  try { db.prepare('ALTER TABLE usuarios ADD COLUMN ultimo_acesso DATETIME').run(); } catch {}
  try { db.prepare('ALTER TABLE usuarios ADD COLUMN boas_vindas_em DATETIME').run(); } catch {} // assistiu o vídeo de boas-vindas
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos_assistidos (
      usuario_id INTEGER NOT NULL,
      chave TEXT NOT NULL,          -- "<rota>::<título do vídeo>" (ver src/app/shared/video-panel/videos-etapas.ts)
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (usuario_id, chave)
    );
    CREATE TABLE IF NOT EXISTS config_app (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,          -- JSON
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comunicados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      mensagem TEXT NOT NULL DEFAULT '',
      imagem_url TEXT NOT NULL DEFAULT '',
      botao_texto TEXT NOT NULL DEFAULT '',
      botao_link TEXT NOT NULL DEFAULT '',
      publico TEXT NOT NULL DEFAULT 'todos',  -- todos | assinantes | nao_assinantes
      inicio TEXT,                            -- AAAA-MM-DD (vazio = já)
      fim TEXT,                               -- AAAA-MM-DD (vazio = sem fim)
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comunicados_vistos (
      usuario_id INTEGER NOT NULL,
      comunicado_id INTEGER NOT NULL,
      visto_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (usuario_id, comunicado_id)
    );
  `);

  // Master pelos e-mails de MASTER_EMAILS
  const emailsMaster = String(process.env.MASTER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emailsMaster.length) {
    const marcar = db.prepare("UPDATE usuarios SET papel = 'master' WHERE lower(email) = ?");
    for (const e of emailsMaster) marcar.run(e);
  }
  // Também vale para quem se cadastrou depois de o servidor subir com o e-mail em MASTER_EMAILS
  const ehMaster = (usuarioId) => {
    const u = db.prepare('SELECT papel, email FROM usuarios WHERE id = ?').get(usuarioId);
    return !!u && (u.papel === 'master' || emailsMaster.includes(String(u.email).toLowerCase()));
  };
  function master() {
    const autenticar = auth();
    return (req, res, next) => autenticar(req, res, () => {
      if (!ehMaster(req.user.id)) return res.status(403).json({ erro: 'Acesso restrito ao master' });
      next();
    });
  }

  app.get('/auth/papel', auth(), (req, res) => res.json({ master: ehMaster(req.user.id) }));

  // ── Uploads de imagem (foto do anúncio, imagem dos avisos) ──
  const PASTA_UPLOADS = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
  app.use('/uploads', require('express').static(PASTA_UPLOADS, { maxAge: '7d', index: false }));
  const TIPOS_IMAGEM = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  app.post('/admin/uploads', master(), (req, res) => {
    const m = String(req.body?.arquivo || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) return res.status(400).json({ erro: 'Envie uma imagem JPG, PNG ou WebP' });
    const dados = Buffer.from(m[2], 'base64');
    if (dados.length > 5 * 1024 * 1024) return res.status(400).json({ erro: 'Imagem maior que 5 MB' });
    const nome = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${TIPOS_IMAGEM[m[1]]}`;
    fs.writeFileSync(path.join(PASTA_UPLOADS, nome), dados);
    res.status(201).json({ url: `/uploads/${nome}` });
  });

  // ── Configurações do app (JSON por chave) ──
  const lerConfig = (chave, padrao) => {
    const r = db.prepare('SELECT valor FROM config_app WHERE chave = ?').get(chave);
    try { return r ? { ...padrao, ...JSON.parse(r.valor) } : { ...padrao }; } catch { return { ...padrao }; }
  };
  const gravarConfig = (chave, valor) => db.prepare(`INSERT INTO config_app (chave, valor, atualizado_em) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = CURRENT_TIMESTAMP`).run(chave, JSON.stringify(valor));

  const texto = (v, max) => String(v ?? '').trim().slice(0, max);
  function validarAnuncio(b) {
    const pontos = (Array.isArray(b.pontos) ? b.pontos : []).slice(0, 5)
      .map((p) => ({ titulo: texto(p?.titulo, 60), texto: texto(p?.texto, 200) })).filter((p) => p.titulo || p.texto);
    return {
      ativo: !!b.ativo,
      botao_menu: texto(b.botao_menu, 40) || ANUNCIO_PADRAO.botao_menu,
      selo: texto(b.selo, 50),
      titulo: texto(b.titulo, 160) || ANUNCIO_PADRAO.titulo,
      pontos,
      destaque: texto(b.destaque, 120),
      botao_agendar: texto(b.botao_agendar, 40) || ANUNCIO_PADRAO.botao_agendar,
      whatsapp: String(b.whatsapp || '').replace(/\D/g, '').slice(0, 15),
      mensagem: texto(b.mensagem, 500) || ANUNCIO_PADRAO.mensagem,
      foto_url: texto(b.foto_url, 300),
      cor_botao_menu: CORES_ANUNCIO.includes(b.cor_botao_menu) ? b.cor_botao_menu : 'lima',
      cor_destaque: CORES_ANUNCIO.includes(b.cor_destaque) ? b.cor_destaque : 'lima',
      cor_botao_agendar: CORES_ANUNCIO.includes(b.cor_botao_agendar) ? b.cor_botao_agendar : 'lima',
    };
  }

  // ── Painel de vídeos: títulos e links ajustados pelo master, por cima de videos-etapas.ts ──
  // videos: { "<rota>::<título original>": { titulo?, link? } }, chamadas: { rota: { texto?, link? } }.
  // Só guarda o que difere do padrão do app; link vazio = "Vídeo em breve".
  const VIDEOS_PADRAO = { titulo_painel: '', videos: {}, chamadas: {} };
  function validarVideos(b) {
    const videos = {};
    for (const [k, a] of Object.entries(b.videos && typeof b.videos === 'object' ? b.videos : {}).slice(0, 400)) {
      if (typeof k !== 'string' || k.length > 200 || !k.includes('::') || !a || typeof a !== 'object') continue;
      const v = {};
      if (a.titulo !== undefined) { const t = texto(a.titulo, 100); if (t) v.titulo = t; }
      if (a.link !== undefined) {
        const l = texto(a.link, 300);
        if (l && !ID_YOUTUBE.test(l)) return { erro: `Link do YouTube inválido em "${k.split('::')[1]}".` };
        v.link = l;
      }
      if (Object.keys(v).length) videos[k] = v;
    }
    const chamadas = {};
    for (const [rota, a] of Object.entries(b.chamadas && typeof b.chamadas === 'object' ? b.chamadas : {}).slice(0, 50)) {
      if (!/^[a-z-]{1,40}$/.test(rota) || !a || typeof a !== 'object') continue;
      const c = {};
      if (a.texto !== undefined) { const t = texto(a.texto, 40); if (t) c.texto = t; }
      if (a.link !== undefined) {
        const l = texto(a.link, 500);
        if (l && !/^https?:\/\//i.test(l)) return { erro: 'O link do botão precisa começar com https://' };
        c.link = l;
      }
      if (Object.keys(c).length) chamadas[rota] = c;
    }
    return { titulo_painel: texto(b.titulo_painel, 60), videos, chamadas };
  }
  app.get('/videos-painel', auth(), (req, res) => res.json(lerConfig('videos_painel', VIDEOS_PADRAO)));
  app.put('/admin/videos-painel', master(), (req, res) => {
    const v = validarVideos(req.body || {});
    if (v.erro) return res.status(400).json(v);
    gravarConfig('videos_painel', v);
    res.json(v);
  });

  // ── Vídeo de boas-vindas ──
  function validarBoasVindas(b) {
    const link = texto(b.link, 300);
    if (b.ativo && !ID_YOUTUBE.test(link)) return { erro: 'Cole um link do YouTube válido (watch?v=, youtu.be/ ou shorts/).' };
    return {
      ativo: !!b.ativo,
      link,
      titulo: texto(b.titulo, 100),
      botao: texto(b.botao, 60) || BOAS_VINDAS_PADRAO.botao,
    };
  }
  // Cliente: mostra o vídeo enquanto não tiver assistido até o fim. O master pode fechar quando quiser.
  app.get('/boas-vindas', auth(), (req, res) => {
    const cfg = lerConfig('boas_vindas', BOAS_VINDAS_PADRAO);
    const u = db.prepare('SELECT boas_vindas_em FROM usuarios WHERE id = ?').get(req.user.id);
    const mostrar = !!cfg.ativo && ID_YOUTUBE.test(cfg.link) && !!u && !u.boas_vindas_em;
    res.json({ mostrar, master: ehMaster(req.user.id), link: cfg.link, titulo: cfg.titulo, botao: cfg.botao });
  });
  app.post('/boas-vindas/concluir', auth(), (req, res) => {
    db.prepare('UPDATE usuarios SET boas_vindas_em = COALESCE(boas_vindas_em, CURRENT_TIMESTAMP) WHERE id = ?').run(req.user.id);
    res.json({ ok: true });
  });
  app.get('/admin/boas-vindas', master(), (req, res) => {
    const cfg = lerConfig('boas_vindas', BOAS_VINDAS_PADRAO);
    const n = db.prepare('SELECT COUNT(*) AS total, COUNT(boas_vindas_em) AS assistiram FROM usuarios').get();
    res.json({ ...cfg, ...n });
  });
  app.put('/admin/boas-vindas', master(), (req, res) => {
    const v = validarBoasVindas(req.body || {});
    if (v.erro) return res.status(400).json(v);
    gravarConfig('boas_vindas', v);
    res.json(v);
  });

  // Cliente: lê o anúncio (o botão do menu some quando está desligado)
  app.get('/anuncio-planejador', auth(), (req, res) => res.json(lerConfig('anuncio_planejador', ANUNCIO_PADRAO)));
  app.get('/admin/anuncio-planejador', master(), (req, res) => res.json(lerConfig('anuncio_planejador', ANUNCIO_PADRAO)));
  app.put('/admin/anuncio-planejador', master(), (req, res) => {
    const v = validarAnuncio(req.body || {});
    if (v.ativo && v.whatsapp.length < 12) return res.status(400).json({ erro: 'Informe o WhatsApp com DDI e DDD (ex.: 5562999999999)' });
    gravarConfig('anuncio_planejador', v);
    res.json(v);
  });

  // ── Avisos que surgem no acesso do cliente ──
  const dataOk = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null);
  function validarComunicado(b) {
    if (!texto(b.titulo, 120)) return { erro: 'Informe o título' };
    const link = texto(b.botao_link, 400);
    if (link && !/^(https?:\/\/|\/)/.test(link)) return { erro: 'O link do botão deve começar com https:// ou /' };
    return {
      titulo: texto(b.titulo, 120), mensagem: texto(b.mensagem, 2000), imagem_url: texto(b.imagem_url, 300),
      botao_texto: texto(b.botao_texto, 40), botao_link: link,
      publico: PUBLICOS.includes(b.publico) ? b.publico : 'todos',
      inicio: dataOk(b.inicio), fim: dataOk(b.fim), ativo: b.ativo === undefined ? 1 : (b.ativo ? 1 : 0),
    };
  }
  // `temAssinatura(usuarioId)` vem de pagamentos.js (público "assinantes" / "não assinantes")
  let temAssinatura = () => false;

  app.get('/comunicados/pendentes', auth(), (req, res) => {
    const { hoje } = agoraBrasilia();
    const assinante = temAssinatura(req.user.id);
    const lista = db.prepare(`SELECT c.* FROM comunicados c
      WHERE c.ativo = 1 AND (c.inicio IS NULL OR c.inicio <= ?) AND (c.fim IS NULL OR c.fim >= ?)
        AND NOT EXISTS (SELECT 1 FROM comunicados_vistos v WHERE v.comunicado_id = c.id AND v.usuario_id = ?)
      ORDER BY c.criado_em DESC, c.id DESC`).all(hoje, hoje, req.user.id)
      .filter((c) => c.publico === 'todos' || (c.publico === 'assinantes') === assinante);
    res.json(lista);
  });
  app.post('/comunicados/:id/visto', auth(), (req, res) => {
    db.prepare('INSERT OR IGNORE INTO comunicados_vistos (usuario_id, comunicado_id) VALUES (?, ?)').run(req.user.id, req.params.id);
    res.json({ ok: true });
  });

  app.get('/admin/comunicados', master(), (req, res) => {
    res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM comunicados_vistos v WHERE v.comunicado_id = c.id) AS vistos
      FROM comunicados c ORDER BY c.criado_em DESC, c.id DESC`).all());
  });
  app.post('/admin/comunicados', master(), (req, res) => {
    const v = validarComunicado(req.body || {});
    if (v.erro) return res.status(400).json(v);
    const r = db.prepare(`INSERT INTO comunicados (titulo, mensagem, imagem_url, botao_texto, botao_link, publico, inicio, fim, ativo)
      VALUES (@titulo, @mensagem, @imagem_url, @botao_texto, @botao_link, @publico, @inicio, @fim, @ativo)`).run(v);
    res.status(201).json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(r.lastInsertRowid));
  });
  app.put('/admin/comunicados/:id', master(), (req, res) => {
    const v = validarComunicado(req.body || {});
    if (v.erro) return res.status(400).json(v);
    const r = db.prepare(`UPDATE comunicados SET titulo=@titulo, mensagem=@mensagem, imagem_url=@imagem_url, botao_texto=@botao_texto,
      botao_link=@botao_link, publico=@publico, inicio=@inicio, fim=@fim, ativo=@ativo WHERE id=@id`).run({ ...v, id: req.params.id });
    if (!r.changes) return res.status(404).json({ erro: 'Aviso não encontrado' });
    res.json(db.prepare('SELECT * FROM comunicados WHERE id = ?').get(req.params.id));
  });
  app.delete('/admin/comunicados/:id', master(), (req, res) => {
    db.prepare('DELETE FROM comunicados_vistos WHERE comunicado_id = ?').run(req.params.id);
    db.prepare('DELETE FROM comunicados WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Textos das mensagens de alerta (valem para todos os clientes) ──
  const { TIPOS_ALERTA, TEXTOS_ALERTA, preencherTexto } = require('./whatsapp');
  const textosSalvos = () => lerConfig('textos_alertas', {});
  app.get('/admin/textos-alertas', master(), (req, res) => {
    const salvos = textosSalvos();
    res.json(Object.entries(TEXTOS_ALERTA).map(([tipo, t]) => ({
      tipo, titulo: TIPOS_ALERTA[tipo]?.titulo || tipo, padrao: t.padrao, texto: salvos[tipo] || '',
      variaveis: Object.keys(t.variaveis), exemplo: preencherTexto(salvos[tipo] || t.padrao, t.variaveis), valores_exemplo: t.variaveis,
    })));
  });
  // texto vazio = volta ao padrão
  app.put('/admin/textos-alertas/:tipo', master(), (req, res) => {
    const t = TEXTOS_ALERTA[req.params.tipo];
    if (!t) return res.status(404).json({ erro: 'Tipo de alerta desconhecido' });
    const texto = String(req.body?.texto ?? '').trim().slice(0, 1000);
    const desconhecidas = [...texto.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !(k in t.variaveis));
    if (desconhecidas.length) return res.status(400).json({ erro: `Variável desconhecida: ${[...new Set(desconhecidas)].map((k) => `{${k}}`).join(', ')}` });
    const salvos = textosSalvos();
    if (texto) salvos[req.params.tipo] = texto; else delete salvos[req.params.tipo];
    gravarConfig('textos_alertas', salvos);
    res.json({ tipo: req.params.tipo, texto, exemplo: preencherTexto(texto || t.padrao, t.variaveis) });
  });

  // ── Vídeos assistidos (no servidor, para o master acompanhar) ──
  app.get('/videos-assistidos', auth(), (req, res) => {
    res.json(db.prepare('SELECT chave FROM videos_assistidos WHERE usuario_id = ?').all(req.user.id).map((r) => r.chave));
  });
  app.post('/videos-assistidos', auth(), (req, res) => {
    const chaves = [].concat(req.body?.chaves ?? req.body?.chave ?? []).map((c) => String(c).slice(0, 200)).filter(Boolean).slice(0, 200);
    const ins = db.prepare('INSERT OR IGNORE INTO videos_assistidos (usuario_id, chave) VALUES (?, ?)');
    db.transaction(() => chaves.forEach((c) => ins.run(req.user.id, c)))();
    res.json({ ok: true });
  });

  // ── Clientes (visão master) ──
  // Nível de utilização (0 a 5): média de 5 partes de 0 a 1, × 5. O backend devolve 4 partes; a dos
  // vídeos é calculada na tela, que conhece o catálogo atual de vídeos (videos-etapas.ts).
  //   acesso: último acesso até 2 dias = 1 · 7 dias = 0,75 · 14 = 0,5 · 30 = 0,25 · mais = 0
  //   lancamentos: gastos lançados nos últimos 30 dias ÷ 30 (máx. 1)
  //   cadastro: 1/4 por bloco preenchido — recebimentos, pessoas, 10+ itens com meta, dívidas/sonhos/cartões
  //   whatsapp: mensagens nos últimos 30 dias ÷ 20 (máx. 1)
  const conta = (sql, ...a) => Number(db.prepare(sql).get(...a)?.n) || 0;
  function partesUtilizacao(u) {
    const dias = u.ultimo_acesso ? (Date.now() - Date.parse(u.ultimo_acesso.replace(' ', 'T') + 'Z')) / 864e5 : Infinity;
    const acesso = dias <= 2 ? 1 : dias <= 7 ? 0.75 : dias <= 14 ? 0.5 : dias <= 30 ? 0.25 : 0;
    const lanc = conta("SELECT COUNT(*) AS n FROM lancamentos_gastos WHERE usuario_id = ? AND criado_em >= datetime('now', '-30 days')", u.id);
    const cadastro = [
      conta('SELECT COUNT(*) AS n FROM recebimentos WHERE usuario_id = ? AND valor > 0', u.id) > 0,
      conta('SELECT COUNT(*) AS n FROM pessoas WHERE usuario_id = ?', u.id) > 0,
      conta('SELECT COUNT(*) AS n FROM gastos WHERE usuario_id = ? AND valor > 0', u.id) >= 10,
      conta('SELECT (SELECT COUNT(*) FROM dividas WHERE usuario_id = ?) + (SELECT COUNT(*) FROM sonhos WHERE usuario_id = ?) + (SELECT COUNT(*) FROM cartoes WHERE usuario_id = ?) AS n', u.id, u.id, u.id) > 0,
    ].filter(Boolean).length / 4;
    const wpp = conta("SELECT COUNT(*) AS n FROM whatsapp_mensagens WHERE usuario_id = ? AND canal = 'whatsapp' AND criado_em >= datetime('now', '-30 days')", u.id);
    return { acesso, lancamentos: Math.min(lanc / 30, 1), cadastro, whatsapp: Math.min(wpp / 20, 1) };
  }

  function resumoCliente(u) {
    const pessoas = db.prepare('SELECT id, nome, telefone, email FROM pessoas WHERE usuario_id = ? ORDER BY id').all(u.id)
      .map((p) => ({ ...p, telefone: decifrar(p.telefone), email: decifrar(p.email) }));
    const comp = componentesOrcamento(u.id);
    const saude = nivelSaude(comp);
    const grau = grauComprometimento(u.id);
    const patrimonio = Number(db.prepare("SELECT COALESCE(SUM(valor_atual), 0) AS t FROM ativos WHERE usuario_id = ? AND guia = 'financeiros'").get(u.id).t) || 0;
    const ultimo = db.prepare(`SELECT l.data, l.valor, l.descricao, l.origem, l.criado_em, g.descricao AS item FROM lancamentos_gastos l
      LEFT JOIN gastos g ON g.id = l.gasto_id WHERE l.usuario_id = ? ORDER BY l.criado_em DESC, l.id DESC LIMIT 1`).get(u.id);
    return {
      id: u.id,
      nome: pessoas[0]?.nome || u.nome,
      email: u.email,
      telefone: pessoas.find((p) => p.telefone)?.telefone || '',
      pessoas: pessoas.map((p) => ({ nome: p.nome, telefone: p.telefone || '', email: p.email || '' })),
      casado: pessoas.length >= 2,
      criado_em: u.criado_em,
      ultimo_acesso: u.ultimo_acesso,
      renda_mensal: comp.H,
      patrimonio_financeiro: Math.round(patrimonio * 100) / 100,
      nivel_saude: saude.nivel,
      nivel_saude_motivo: saude.motivo,
      grau_comprometimento: grau.percentual,
      componentes: comp,
      videos_assistidos: db.prepare('SELECT chave FROM videos_assistidos WHERE usuario_id = ?').all(u.id).map((r) => r.chave),
      ultimo_gasto: ultimo || null,
      utilizacao_partes: partesUtilizacao(u),
    };
  }

  app.get('/admin/clientes', master(), (req, res) => {
    // Inclui o próprio master (marcado), que também pode usar o app como cliente
    const usuarios = db.prepare("SELECT id, nome, email, papel, criado_em, ultimo_acesso FROM usuarios WHERE email NOT LIKE '%@zevem.invalid' ORDER BY criado_em DESC").all();
    res.json(usuarios.map((u) => ({ ...resumoCliente(u), master: u.papel === 'master' })));
  });

  return { ehMaster, master, definirTemAssinatura: (fn) => { temAssinatura = fn; } };
};
