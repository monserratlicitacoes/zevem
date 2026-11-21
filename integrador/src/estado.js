// Estado local do integrador (SQLite embutido do Node). Garante que nenhuma mensagem se perde num
// reinício e que uma resposta já entregue nunca é reenviada.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

module.exports = function abrirEstado(dataDir, arquivo = 'integrador.db') {
  const db = new DatabaseSync(arquivo === ':memory:' ? arquivo : path.join(dataDir, arquivo));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    -- Mensagens recebidas. estado: recebida → processada (resposta do Zevem guardada) → respondida | falhou
    CREATE TABLE IF NOT EXISTS entrada (
      id TEXT PRIMARY KEY,            -- id da mensagem no provedor (wamid na Meta)
      provedor TEXT NOT NULL,
      telefone TEXT NOT NULL,         -- como o provedor entregou (com 55)
      destino TEXT NOT NULL,          -- para onde responder
      tipo TEXT NOT NULL,             -- texto | audio | outro
      tipo_original TEXT,
      texto TEXT,
      midia_id TEXT,
      transcrito INTEGER NOT NULL DEFAULT 0,
      recebida_em TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'recebida',
      resposta TEXT,
      resposta_id TEXT,
      tentativas INTEGER NOT NULL DEFAULT 0,
      proximo_em INTEGER NOT NULL DEFAULT 0,
      erro TEXT,
      criado_em INTEGER NOT NULL,
      atualizado_em INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entrada_pendente ON entrada (estado, proximo_em);
    -- Último contato de cada número: destino exato (nono dígito) e janela de 24h
    CREATE TABLE IF NOT EXISTS contatos (
      chave TEXT PRIMARY KEY,
      destino TEXT NOT NULL,
      ultima_recebida_em INTEGER NOT NULL
    );
    -- Tentativas de envio dos avisos da fila
    CREATE TABLE IF NOT EXISTS envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aviso_id INTEGER NOT NULL,
      destino TEXT,
      forma TEXT,                     -- texto | template
      provedor_id TEXT,
      status TEXT NOT NULL,           -- enviado | falhou | entregue | lido | falhou_entrega
      erro TEXT,
      confirmado INTEGER NOT NULL DEFAULT 0,
      criado_em INTEGER NOT NULL,
      atualizado_em INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS envios_aviso ON envios (aviso_id);
    CREATE INDEX IF NOT EXISTS envios_provedor ON envios (provedor_id);
  `);

  const agora = () => Date.now();
  const st = {
    inserir: db.prepare(`INSERT OR IGNORE INTO entrada (id, provedor, telefone, destino, tipo, tipo_original, texto, midia_id, recebida_em, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    pendentes: db.prepare(`SELECT * FROM entrada WHERE estado IN ('recebida', 'processada') AND proximo_em <= ? ORDER BY criado_em LIMIT 50`),
    contato: db.prepare('SELECT * FROM contatos WHERE chave = ?'),
    salvarContato: db.prepare(`INSERT INTO contatos (chave, destino, ultima_recebida_em) VALUES (?, ?, ?)
      ON CONFLICT(chave) DO UPDATE SET destino = excluded.destino, ultima_recebida_em = MAX(ultima_recebida_em, excluded.ultima_recebida_em)`),
  };

  return {
    db,
    // true se a mensagem é nova (o provedor reentrega a mesma mensagem: a repetição é ignorada)
    registrarEntrada(m, provedor) {
      const t = agora();
      return st.inserir.run(m.id, provedor, m.telefone, m.destino, m.tipo, m.tipo_original || null, m.texto || '', m.midia_id || null,
        m.recebida_em, t, t).changes > 0;
    },
    entradasPendentes: (ate = agora()) => st.pendentes.all(ate),
    entrada: (id) => db.prepare('SELECT * FROM entrada WHERE id = ?').get(id),
    salvarTranscricao(id, texto) {
      db.prepare('UPDATE entrada SET texto = ?, transcrito = 1, atualizado_em = ? WHERE id = ?').run(texto, agora(), id);
    },
    marcarProcessada(id, resposta) {
      db.prepare(`UPDATE entrada SET estado = 'processada', resposta = ?, erro = NULL, proximo_em = 0, atualizado_em = ? WHERE id = ? AND estado = 'recebida'`)
        .run(resposta ?? '', agora(), id);
    },
    marcarRespondida(id, respostaId) {
      db.prepare(`UPDATE entrada SET estado = 'respondida', resposta_id = ?, erro = NULL, atualizado_em = ? WHERE id = ?`).run(respostaId ?? null, agora(), id);
    },
    reagendar(id, tentativas, proximoEm, erro) {
      db.prepare('UPDATE entrada SET tentativas = ?, proximo_em = ?, erro = ?, atualizado_em = ? WHERE id = ?').run(tentativas, proximoEm, erro, agora(), id);
    },
    marcarFalha(id, erro) {
      db.prepare(`UPDATE entrada SET estado = 'falhou', erro = ?, atualizado_em = ? WHERE id = ?`).run(erro, agora(), id);
    },

    contato: (chave) => (chave ? st.contato.get(chave) : undefined),
    salvarContato(chave, destino, quando = agora()) {
      if (chave && destino) st.salvarContato.run(chave, destino, quando);
    },

    registrarEnvio({ aviso_id, destino, forma, provedor_id, status, erro }) {
      const t = agora();
      return Number(db.prepare(`INSERT INTO envios (aviso_id, destino, forma, provedor_id, status, erro, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(aviso_id, destino ?? null, forma ?? null, provedor_id ?? null, status, erro ?? null, t, t).lastInsertRowid);
    },
    marcarEnvioConfirmado(id) {
      db.prepare('UPDATE envios SET confirmado = 1, atualizado_em = ? WHERE id = ?').run(agora(), id);
    },
    // Já enviado antes (a confirmação ao Zevem pode ter falhado): não manda de novo ao usuário
    envioJaFeito: (avisoId) => db.prepare(`SELECT * FROM envios WHERE aviso_id = ? AND status IN ('enviado', 'entregue', 'lido') ORDER BY id DESC LIMIT 1`).get(avisoId),
    falhasDoAviso: (avisoId) => db.prepare(`SELECT COUNT(*) AS n FROM envios WHERE aviso_id = ? AND status = 'falhou'`).get(avisoId).n,
    // Retorno do provedor (entregue, lido, falha de entrega) sobre um envio já feito
    atualizarStatusProvedor(provedorId, status, erro) {
      return db.prepare('UPDATE envios SET status = ?, erro = COALESCE(?, erro), atualizado_em = ? WHERE provedor_id = ?')
        .run(status, erro ?? null, agora(), provedorId).changes;
    },

    // Mensagens antigas não precisam ficar aqui (o histórico fica no Zevem)
    limpar(diasEntrada = 7, diasEnvios = 30) {
      db.prepare(`DELETE FROM entrada WHERE estado IN ('respondida', 'falhou') AND atualizado_em < ?`).run(agora() - diasEntrada * 86_400_000);
      db.prepare('DELETE FROM envios WHERE atualizado_em < ?').run(agora() - diasEnvios * 86_400_000);
    },
    resumo() {
      const linhas = db.prepare('SELECT estado, COUNT(*) AS n FROM entrada GROUP BY estado').all();
      return Object.fromEntries(linhas.map((l) => [l.estado, l.n]));
    },
    fechar: () => db.close(),
  };
};
