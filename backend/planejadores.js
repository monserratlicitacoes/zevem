// ── Planejadores financeiros associados ──
//
// O master convida o planejador (nome completo, e-mail, CPF e telefone) no menu "Planejadores".
// O planejador cria a conta pelo link e passa a ter o papel 'planejador'. Na área dele convida
// clientes (o cliente que se cadastra pelo link fica vinculado em usuarios.planejador_id), vê a
// lista dos seus clientes e pode remover (e devolver) o acesso deles.
//
// Remover acesso = usuarios.bloqueado_em: a pessoa não entra mais e as sessões abertas caem; os
// dados ficam guardados e o acesso pode ser devolvido. O master remove/devolve o acesso de qualquer
// cliente ou planejador; o planejador só o dos seus clientes, e só devolve o que ele mesmo removeu.

const { decifrar } = require('./cripto');

module.exports = function registrarPlanejadores(ctx) {
  const { app, db, auth, master, ehMaster, convites, gerarTokenSuporte } = ctx;

  db.exec(`
    CREATE TABLE IF NOT EXISTS planejadores (
      usuario_id INTEGER PRIMARY KEY,
      cpf TEXT NOT NULL DEFAULT '',        -- cifrado (cripto.js)
      telefone TEXT NOT NULL DEFAULT '',   -- cifrado (cripto.js)
      criado_por INTEGER,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usuarios_planejador ON usuarios(planejador_id);
    -- Quem entrou na conta de qual cliente, e quando (registro para o cliente e para auditoria)
    CREATE TABLE IF NOT EXISTS acessos_cliente (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ator_id INTEGER NOT NULL,
      cliente_id INTEGER NOT NULL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const usuario = (id) => db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  const ehPlanejador = (id) => usuario(id)?.papel === 'planejador';

  function planejador() {
    const autenticar = auth();
    return (req, res, next) => autenticar(req, res, () => {
      if (!ehPlanejador(req.user.id)) return res.status(403).json({ erro: 'Acesso restrito ao planejador' });
      next();
    });
  }

  // Telefone principal do cliente: o da primeira pessoa cadastrada que tiver telefone
  const telefoneCliente = (id) => db.prepare("SELECT telefone FROM pessoas WHERE usuario_id = ? AND telefone != '' ORDER BY id").all(id)
    .map((p) => decifrar(p.telefone)).find(Boolean) || '';

  const resumoCliente = (u) => ({
    id: u.id, nome: u.nome, email: u.email, telefone: telefoneCliente(u.id), criado_em: u.criado_em, ultimo_acesso: u.ultimo_acesso,
    ativo: !u.bloqueado_em, bloqueado_em: u.bloqueado_em,
    bloqueado_pelo_master: !!u.bloqueado_em && !!u.bloqueado_por && u.bloqueado_por !== u.planejador_id,
  });
  const clientesDe = (planejadorId) => db.prepare(`SELECT * FROM usuarios WHERE planejador_id = ? AND email NOT LIKE '%@zevem.invalid'
    ORDER BY bloqueado_em IS NOT NULL, nome COLLATE NOCASE`).all(planejadorId).map(resumoCliente);

  function resumoPlanejador(u) {
    const p = db.prepare('SELECT * FROM planejadores WHERE usuario_id = ?').get(u.id) || {};
    const n = db.prepare(`SELECT COUNT(*) AS total, COUNT(*) - COUNT(bloqueado_em) AS ativos FROM usuarios
      WHERE planejador_id = ? AND email NOT LIKE '%@zevem.invalid'`).get(u.id);
    const pendentes = db.prepare(`SELECT COUNT(*) AS n FROM convites WHERE planejador_id = ? AND usado_em IS NULL
      AND cancelado_em IS NULL AND expira_em > datetime('now')`).get(u.id).n;
    return {
      id: u.id, nome: u.nome, email: u.email, cpf: decifrar(p.cpf), telefone: decifrar(p.telefone),
      criado_em: u.criado_em, ultimo_acesso: u.ultimo_acesso, ativo: !u.bloqueado_em, bloqueado_em: u.bloqueado_em,
      clientes_ativos: n.ativos, clientes_total: n.total, convites_pendentes: pendentes,
    };
  }

  // Remove/devolve o acesso. Remover derruba as sessões abertas (sessao_versao).
  function bloquear(alvoId, porId) {
    db.transaction(() => {
      db.prepare(`UPDATE usuarios SET bloqueado_em = CURRENT_TIMESTAMP, bloqueado_por = ?, sessao_versao = sessao_versao + 1
        WHERE id = ? AND bloqueado_em IS NULL`).run(porId, alvoId);
      // Planejador sem acesso: os convites dele em aberto deixam de valer
      if (ehPlanejador(alvoId)) {
        db.prepare('UPDATE convites SET cancelado_em = CURRENT_TIMESTAMP WHERE planejador_id = ? AND usado_em IS NULL AND cancelado_em IS NULL').run(alvoId);
      }
    })();
  }
  const desbloquear = (alvoId) => db.prepare('UPDATE usuarios SET bloqueado_em = NULL, bloqueado_por = NULL WHERE id = ?').run(alvoId);

  // ── Master ──
  app.get('/admin/planejadores', master(), (req, res) => {
    const lista = db.prepare("SELECT * FROM usuarios WHERE papel = 'planejador' AND email NOT LIKE '%@zevem.invalid' ORDER BY nome COLLATE NOCASE").all();
    res.json(lista.map(resumoPlanejador));
  });

  app.post('/admin/planejadores/convites', master(), async (req, res) => {
    const b = req.body || {};
    const r = await convites.criar({ email: b.email, nome: b.nome, tipo: 'planejador', cpf: b.cpf, telefone: b.telefone, criadoPor: req.user.id });
    res.status(r.status).json(r.corpo);
  });

  app.get('/admin/planejadores/:id/clientes', master(), (req, res) => {
    const u = usuario(Number(req.params.id));
    if (!u || u.papel !== 'planejador') return res.status(404).json({ erro: 'Planejador não encontrado.' });
    res.json(clientesDe(u.id));
  });

  app.post('/admin/usuarios/:id/remover-acesso', master(), (req, res) => {
    const u = usuario(Number(req.params.id));
    if (!u || u.email.endsWith('@zevem.invalid')) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (ehMaster(u.id)) return res.status(400).json({ erro: 'O acesso do master não pode ser removido.' });
    bloquear(u.id, req.user.id);
    res.json({ ok: true });
  });

  app.post('/admin/usuarios/:id/devolver-acesso', master(), (req, res) => {
    const u = usuario(Number(req.params.id));
    if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    desbloquear(u.id);
    res.json({ ok: true });
  });

  // Troca (ou tira) o planejador de um cliente. planejador_id null = cliente direto do Zevem.
  app.put('/admin/usuarios/:id/planejador', master(), (req, res) => {
    const u = usuario(Number(req.params.id));
    if (!u || u.papel !== 'cliente') return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const pid = req.body?.planejador_id ? Number(req.body.planejador_id) : null;
    if (pid && !ehPlanejador(pid)) return res.status(400).json({ erro: 'Planejador não encontrado.' });
    db.prepare('UPDATE usuarios SET planejador_id = ? WHERE id = ?').run(pid, u.id);
    res.json({ ok: true });
  });

  // ── Planejador ──
  app.get('/planejador/clientes', planejador(), (req, res) => res.json(clientesDe(req.user.id)));

  app.get('/planejador/convites', planejador(), (req, res) => {
    res.json(db.prepare('SELECT * FROM convites WHERE planejador_id = ? ORDER BY id DESC LIMIT 300').all(req.user.id).map(convites.resumo));
  });

  app.post('/planejador/convites', planejador(), async (req, res) => {
    const r = await convites.criar({ email: req.body?.email, nome: req.body?.nome, planejadorId: req.user.id, criadoPor: req.user.id });
    res.status(r.status).json(r.corpo);
  });

  // Só os convites do próprio planejador
  const conviteMeu = (req) => {
    const c = convites.porId(Number(req.params.id));
    return c && c.planejador_id === req.user.id ? c : null;
  };
  app.post('/planejador/convites/:id/reenviar', planejador(), async (req, res) => {
    const r = await convites.reenviar(conviteMeu(req));
    res.status(r.status).json(r.corpo);
  });
  app.post('/planejador/convites/:id/cancelar', planejador(), (req, res) => {
    const r = convites.cancelar(conviteMeu(req));
    res.status(r.status).json(r.corpo);
  });

  const clienteMeu = (req) => {
    const u = usuario(Number(req.params.id));
    return u && u.planejador_id === req.user.id && u.papel === 'cliente' ? u : null;
  };
  app.post('/planejador/clientes/:id/remover-acesso', planejador(), (req, res) => {
    const u = clienteMeu(req);
    if (!u) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    bloquear(u.id, req.user.id);
    res.json({ ok: true });
  });
  app.post('/planejador/clientes/:id/devolver-acesso', planejador(), (req, res) => {
    const u = clienteMeu(req);
    if (!u) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    if (u.bloqueado_em && u.bloqueado_por !== req.user.id) {
      return res.status(403).json({ erro: 'O acesso deste cliente foi removido pelo Zevem. Fale com o suporte.' });
    }
    desbloquear(u.id);
    res.json({ ok: true });
  });

  // ── Acessar o Zevem do cliente ──
  // O master entra na conta de qualquer cliente; o planejador, só na dos clientes vinculados a ele.
  // A sessão é do cliente (vê e edita tudo como ele), marcada com quem entrou; ver lerSessao em server.js.
  function podeAcessarCliente(atorId, clienteId) {
    const c = usuario(clienteId);
    if (!c || c.papel !== 'cliente' || ehMaster(c.id) || c.bloqueado_em) return false;
    if (ehMaster(atorId)) return true;
    return ehPlanejador(atorId) && c.planejador_id === atorId;
  }

  function entrar(req, res) {
    const c = usuario(Number(req.params.id));
    if (!c || c.email.endsWith('@zevem.invalid')) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    if (c.bloqueado_em) return res.status(400).json({ erro: 'Devolva o acesso do cliente antes de entrar na conta dele.' });
    if (!podeAcessarCliente(req.user.id, c.id)) return res.status(403).json({ erro: 'Você não pode acessar a conta deste cliente.' });
    const ator = usuario(req.user.id);
    db.prepare('INSERT INTO acessos_cliente (ator_id, cliente_id) VALUES (?, ?)').run(ator.id, c.id);
    res.json({ token: gerarTokenSuporte(c, ator), nome: c.nome, email: c.email });
  }
  app.post('/admin/usuarios/:id/acessar', master(), entrar);
  app.post('/planejador/clientes/:id/acessar', planejador(), entrar);

  return { ehPlanejador, podeAcessarCliente };
};
