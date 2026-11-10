// ── Convites: o master informa o e-mail e o convidado recebe um link para se cadastrar ──
//
// O link leva a /cadastro?convite=<token>. Quem se cadastra pelo convite já entra com o e-mail
// confirmado (o link chegou nesse e-mail) e cai direto no app. O cadastro aberto continua igual.

const crypto = require('crypto');

const DIAS_VALIDADE = 30;

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

  const EMAIL_OK = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i; // mesmo formato do cadastro (server.js)
  const link = (token) => `${FRONTEND_URL}/cadastro?convite=${token}`;
  const novaValidade = () => `datetime('now', '+${DIAS_VALIDADE} days')`;

  function situacao(c) {
    if (c.usado_em) return 'aceito';
    if (c.cancelado_em) return 'cancelado';
    if (c.expira_em <= db.prepare("SELECT datetime('now') AS agora").get().agora) return 'expirado';
    return 'pendente';
  }
  const resumo = (c) => ({
    id: c.id, email: c.email, nome: c.nome, criado_em: c.criado_em, expira_em: c.expira_em,
    enviado_em: c.enviado_em, erro_envio: c.erro_envio, usado_em: c.usado_em, usuario_id: c.usuario_id,
    situacao: situacao(c), link: situacao(c) === 'pendente' ? link(c.token) : null,
  });

  async function enviar(c) {
    const ola = c.nome ? `Olá, ${escaparHtml(c.nome)}!` : 'Olá!';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
        <div style="background:#05261a;border-radius:14px;padding:32px;text-align:center;">
          <div style="font-size:22px;font-weight:600;letter-spacing:-0.4px;margin-bottom:16px;">
            <span style="color:#f7f8f5;">ze</span><span style="color:#b8f15a;">vem</span></div>
          <h2 style="color:#f7f8f5;margin:0 0 8px;">${ola}</h2>
          <p style="color:#a8bcb0;font-size:14px;line-height:1.6;margin:0 0 24px;">
            Você foi convidado(a) para o Zevem, o seu planejamento financeiro guiado.
            Crie sua conta pelo botão abaixo.
          </p>
          <a href="${link(c.token)}" style="display:inline-block;background:#b8f15a;color:#05261a;
            padding:14px 32px;border-radius:10px;font-weight:800;text-decoration:none;font-size:14px;">
            Criar minha conta
          </a>
          <p style="color:#a8bcb0;font-size:12px;margin:20px 0 0;">O convite vale por ${DIAS_VALIDADE} dias.</p>
        </div>
      </div>`;
    try {
      await enviarEmail(c.email, 'Seu convite para o Zevem', html);
      db.prepare('UPDATE convites SET enviado_em = CURRENT_TIMESTAMP, erro_envio = NULL WHERE id = ?').run(c.id);
      return null;
    } catch (e) {
      db.prepare('UPDATE convites SET erro_envio = ? WHERE id = ?').run(String(e.message || e).slice(0, 300), c.id);
      return `Convite criado, mas o e-mail não saiu (${e.message}). Copie o link e mande ao convidado.`;
    }
  }

  const porId = (id) => db.prepare('SELECT * FROM convites WHERE id = ?').get(id);

  // ── Master ──
  app.get('/admin/convites', master(), (req, res) => {
    res.json(db.prepare('SELECT * FROM convites ORDER BY id DESC LIMIT 300').all().map(resumo));
  });

  app.post('/admin/convites', master(), async (req, res) => {
    const email = normalizarEmail(req.body?.email);
    const nome = String(req.body?.nome || '').trim().slice(0, 80);
    if (!EMAIL_OK.test(email)) return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    if (db.prepare('SELECT 1 FROM usuarios WHERE lower(trim(email)) = ?').get(email)) {
      return res.status(409).json({ erro: 'Este e-mail já tem conta no Zevem.' });
    }
    // Um convite em aberto por e-mail: o novo substitui os anteriores
    db.prepare('UPDATE convites SET cancelado_em = CURRENT_TIMESTAMP WHERE email = ? AND usado_em IS NULL AND cancelado_em IS NULL').run(email);
    const token = crypto.randomBytes(24).toString('hex');
    const r = db.prepare(`INSERT INTO convites (email, nome, token, criado_por, expira_em) VALUES (?, ?, ?, ?, ${novaValidade()})`)
      .run(email, nome, token, req.user.id);
    const aviso = await enviar(porId(r.lastInsertRowid));
    res.status(201).json({ ...resumo(porId(r.lastInsertRowid)), aviso_email: aviso });
  });

  app.post('/admin/convites/:id/reenviar', master(), async (req, res) => {
    const c = porId(Number(req.params.id));
    if (!c) return res.status(404).json({ erro: 'Convite não encontrado.' });
    if (c.usado_em) return res.status(400).json({ erro: 'Este convite já foi usado.' });
    if (db.prepare('SELECT 1 FROM usuarios WHERE lower(trim(email)) = ?').get(c.email)) {
      return res.status(409).json({ erro: 'Este e-mail já tem conta no Zevem.' });
    }
    // Reenviar reabre e renova a validade
    db.prepare(`UPDATE convites SET cancelado_em = NULL, expira_em = ${novaValidade()} WHERE id = ?`).run(c.id);
    const aviso = await enviar(porId(c.id));
    res.json({ ...resumo(porId(c.id)), aviso_email: aviso });
  });

  app.post('/admin/convites/:id/cancelar', master(), (req, res) => {
    const c = porId(Number(req.params.id));
    if (!c) return res.status(404).json({ erro: 'Convite não encontrado.' });
    if (c.usado_em) return res.status(400).json({ erro: 'Este convite já foi usado.' });
    db.prepare('UPDATE convites SET cancelado_em = CURRENT_TIMESTAMP WHERE id = ?').run(c.id);
    res.json(resumo(porId(c.id)));
  });

  // ── Público: a tela de cadastro consulta o convite para preencher o e-mail ──
  function buscarValido(token) {
    if (!token || typeof token !== 'string') return null;
    const c = db.prepare('SELECT * FROM convites WHERE token = ?').get(token);
    return c && situacao(c) === 'pendente' ? c : null;
  }

  app.get('/convites/:token', loginLimiter, (req, res) => {
    const c = buscarValido(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Este convite não vale mais. Peça um novo a quem te convidou.' });
    res.json({ email: c.email, nome: c.nome });
  });

  return {
    buscarValido,
    marcarUsado: (id, usuarioId) => db.prepare('UPDATE convites SET usado_em = CURRENT_TIMESTAMP, usuario_id = ? WHERE id = ?').run(usuarioId, id),
  };
};
