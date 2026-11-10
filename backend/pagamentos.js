// ── Assinaturas (SaaS): plano anual pago em 12 parcelas, com renovação automática ──
//
// O gateway de pagamento ainda não foi escolhido. Tudo aqui funciona com o provedor "manual" (o master
// dá baixa nas parcelas no menu Financeiro) e o gateway entra depois como um adaptador em PROVEDORES:
//
//   criarAssinatura({ usuario, plano, assinatura, cobrancas }) → { provedor_cliente_id?, provedor_assinatura_id?,
//                     cobrancas: [{ provedor_cobranca_id?, link_pagamento? }] }   (mesma ordem das parcelas)
//   renovarCiclo(...)      → idem, para as parcelas do novo ciclo
//   cancelarAssinatura({ assinatura, imediato })
//   interpretarWebhook(req) → [{ id, tipo, provedor_cobranca_id?, provedor_assinatura_id?, valor?, pago_em?, forma? }]
//                             tipo: cobranca_paga | cobranca_vencida | cobranca_estornada | assinatura_cancelada
//                             (deve validar a assinatura/segredo do webhook e lançar erro se não bater)
//
// Provedor em uso: PAGAMENTOS_PROVEDOR (padrão "manual"). Webhook: POST /pagamentos/webhook/:provedor.
//
// Regras:
//   • Cada ciclo = 12 meses a partir de inicio_ciclo, com 12 cobranças mensais (valor anual ÷ 12, centavos na 1ª).
//   • Cobrança pendente com vencimento passado → "vencida". Assinatura com cobrança vencida há mais de
//     DIAS_TOLERANCIA dias → "inadimplente"; volta a "ativa" quando não houver mais vencidas.
//   • Fim do ciclo: com renovação automática ligada, abre o ciclo seguinte com o preço atual do plano;
//     desligada, a assinatura fica "encerrada".
//   • Cancelar = desligar a renovação (as parcelas do ciclo continuam). Cancelar imediatamente também
//     cancela as parcelas em aberto.
//   • Pedido de cancelamento: o cliente pede (app) ou o master registra (WhatsApp, atendimento); fica
//     "aberto" até o master resolver — cancelar a renovação, cancelar agora ou registrar que o cliente ficou.
//   • encerrada_em = dia em que a assinatura deixou de valer (fim do ciclo sem renovar ou cancelamento
//     imediato). É a data que conta no churn.
//
// Indicadores (menu Financeiro):
//   MRR   = soma da mensalidade (valor do ciclo ÷ parcelas) das assinaturas ativas e inadimplentes
//   ARPU  = MRR ÷ assinantes
//   Churn = assinaturas encerradas no mês ÷ assinaturas que valiam no 1º dia do mês
//   LTV   = ARPU ÷ churn médio dos últimos 3 meses fechados (sem churn no período, não há como estimar)

const DIAS_TOLERANCIA = 5;
const MOTIVOS_CANCELAMENTO = {
  preco: 'Preço', nao_uso: 'Não estou usando', dificuldade: 'Difícil de usar', outra_solucao: 'Contratei outra solução ou planejador',
  financeiro: 'Aperto financeiro', outro: 'Outro motivo',
};
const CANAIS_CANCELAMENTO = ['app', 'whatsapp', 'atendimento'];
const STATUS_COM_ACESSO = ['ativa', 'inadimplente'];

const PROVEDORES = {
  manual: {
    nome: 'Manual (baixa pelo master)',
    async criarAssinatura({ cobrancas }) { return { cobrancas: cobrancas.map(() => ({})) }; },
    async renovarCiclo({ cobrancas }) { return { cobrancas: cobrancas.map(() => ({})) }; },
    async cancelarAssinatura() {},
    interpretarWebhook() { throw new Error('O provedor manual não recebe webhooks'); },
  },
};

module.exports = function registrarPagamentos(ctx) {
  const { app, db, auth, master, agoraBrasilia, dividirEmParcelas, somarMeses } = ctx;

  db.exec(`
    CREATE TABLE IF NOT EXISTS planos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      valor_anual REAL NOT NULL,
      parcelas INTEGER NOT NULL DEFAULT 12,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS assinaturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      plano_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ativa',      -- ativa | inadimplente | cancelada | encerrada
      ciclo INTEGER NOT NULL DEFAULT 1,
      inicio_ciclo TEXT NOT NULL,                 -- AAAA-MM-DD
      fim_ciclo TEXT NOT NULL,                    -- último dia do ciclo
      valor_ciclo REAL NOT NULL,
      renovacao_automatica INTEGER NOT NULL DEFAULT 1,
      provedor TEXT NOT NULL DEFAULT 'manual',
      provedor_cliente_id TEXT,
      provedor_assinatura_id TEXT,
      cancelada_em DATETIME,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_assinaturas_usuario ON assinaturas(usuario_id);
    CREATE TABLE IF NOT EXISTS cobrancas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assinatura_id INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      ciclo INTEGER NOT NULL,
      parcela INTEGER NOT NULL,
      total_parcelas INTEGER NOT NULL,
      valor REAL NOT NULL,
      vencimento TEXT NOT NULL,                   -- AAAA-MM-DD
      status TEXT NOT NULL DEFAULT 'pendente',    -- pendente | paga | vencida | cancelada | estornada
      pago_em TEXT,
      valor_pago REAL,
      forma_pagamento TEXT,
      provedor_cobranca_id TEXT,
      link_pagamento TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cobrancas_assinatura ON cobrancas(assinatura_id, ciclo, parcela);
    CREATE INDEX IF NOT EXISTS idx_cobrancas_provedor ON cobrancas(provedor_cobranca_id);
    CREATE TABLE IF NOT EXISTS pedidos_cancelamento (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      assinatura_id INTEGER NOT NULL,
      motivo TEXT NOT NULL,                       -- chave de MOTIVOS_CANCELAMENTO
      detalhe TEXT NOT NULL DEFAULT '',
      canal TEXT NOT NULL DEFAULT 'app',          -- app | whatsapp | atendimento
      status TEXT NOT NULL DEFAULT 'aberto',      -- aberto | concluido | revertido
      resolucao TEXT,                             -- cancelar_renovacao | cancelar_agora | revertido
      observacao TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolvido_em DATETIME
    );
    CREATE TABLE IF NOT EXISTS pagamentos_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provedor TEXT NOT NULL,
      evento_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      payload TEXT NOT NULL,
      processado INTEGER NOT NULL DEFAULT 0,
      erro TEXT,
      recebido_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provedor, evento_id)
    );
  `);

  try { db.prepare('ALTER TABLE assinaturas ADD COLUMN encerrada_em DATETIME').run(); } catch {}

  const provedorAtual = () => process.env.PAGAMENTOS_PROVEDOR || 'manual';
  const hoje = () => agoraBrasilia().hoje;
  const fimDoCiclo = (inicio) => { const d = new Date(`${somarMeses(inicio, 12)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

  const temAssinatura = (usuarioId) =>
    !!db.prepare(`SELECT 1 FROM assinaturas WHERE usuario_id = ? AND status IN ('ativa', 'inadimplente') LIMIT 1`).get(usuarioId);

  // Parcelas de um ciclo: uma por mês a partir do início
  function parcelasDoCiclo(valorAnual, n, inicio) {
    return dividirEmParcelas(valorAnual, n).map((valor, i) => ({ parcela: i + 1, total_parcelas: n, valor, vencimento: somarMeses(inicio, i) }));
  }
  function gravarCobrancas(assinatura, ciclo, parcelas, doProvedor) {
    const ins = db.prepare(`INSERT INTO cobrancas (assinatura_id, usuario_id, ciclo, parcela, total_parcelas, valor, vencimento, provedor_cobranca_id, link_pagamento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    parcelas.forEach((p, i) => ins.run(assinatura.id, assinatura.usuario_id, ciclo, p.parcela, p.total_parcelas, p.valor, p.vencimento,
      doProvedor?.[i]?.provedor_cobranca_id ?? null, doProvedor?.[i]?.link_pagamento ?? null));
  }

  async function criarAssinatura(usuarioId, plano, inicio) {
    const provedor = PROVEDORES[provedorAtual()];
    if (!provedor) throw new Error(`Provedor de pagamento desconhecido: ${provedorAtual()}`);
    const usuario = db.prepare('SELECT id, nome, email FROM usuarios WHERE id = ?').get(usuarioId);
    const parcelas = parcelasDoCiclo(plano.valor_anual, plano.parcelas, inicio);
    const r = db.prepare(`INSERT INTO assinaturas (usuario_id, plano_id, inicio_ciclo, fim_ciclo, valor_ciclo, provedor) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(usuarioId, plano.id, inicio, fimDoCiclo(inicio), plano.valor_anual, provedorAtual());
    const assinatura = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(r.lastInsertRowid);
    try {
      const resp = await provedor.criarAssinatura({ usuario, plano, assinatura, cobrancas: parcelas });
      db.prepare('UPDATE assinaturas SET provedor_cliente_id = ?, provedor_assinatura_id = ? WHERE id = ?')
        .run(resp.provedor_cliente_id ?? null, resp.provedor_assinatura_id ?? null, assinatura.id);
      gravarCobrancas(assinatura, 1, parcelas, resp.cobrancas);
    } catch (e) {
      db.prepare('DELETE FROM assinaturas WHERE id = ?').run(assinatura.id);
      throw e;
    }
    return assinatura.id;
  }

  // Rotina diária: vencidas, inadimplência, renovação e encerramento
  async function atualizarAssinaturas(dia = hoje()) {
    db.prepare("UPDATE cobrancas SET status = 'vencida' WHERE status = 'pendente' AND vencimento < ?").run(dia);
    const limite = new Date(`${dia}T12:00:00Z`); limite.setUTCDate(limite.getUTCDate() - DIAS_TOLERANCIA);
    const corte = limite.toISOString().slice(0, 10);
    db.prepare(`UPDATE assinaturas SET status = 'inadimplente', atualizado_em = CURRENT_TIMESTAMP WHERE status = 'ativa'
      AND EXISTS (SELECT 1 FROM cobrancas c WHERE c.assinatura_id = assinaturas.id AND c.status = 'vencida' AND c.vencimento < ?)`).run(corte);
    db.prepare(`UPDATE assinaturas SET status = 'ativa', atualizado_em = CURRENT_TIMESTAMP WHERE status = 'inadimplente'
      AND NOT EXISTS (SELECT 1 FROM cobrancas c WHERE c.assinatura_id = assinaturas.id AND c.status = 'vencida' AND c.vencimento < ?)`).run(corte);

    for (const a of db.prepare("SELECT * FROM assinaturas WHERE fim_ciclo < ? AND status IN ('ativa', 'inadimplente', 'cancelada')").all(dia)) {
      if (a.renovacao_automatica && a.status !== 'cancelada') {
        const plano = db.prepare('SELECT * FROM planos WHERE id = ?').get(a.plano_id);
        const inicio = somarMeses(a.inicio_ciclo, 12);
        const parcelas = parcelasDoCiclo(plano.valor_anual, plano.parcelas, inicio);
        const provedor = PROVEDORES[a.provedor] || PROVEDORES.manual;
        try {
          const resp = await provedor.renovarCiclo({ assinatura: a, plano, cobrancas: parcelas });
          db.transaction(() => {
            db.prepare(`UPDATE assinaturas SET ciclo = ciclo + 1, inicio_ciclo = ?, fim_ciclo = ?, valor_ciclo = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(inicio, fimDoCiclo(inicio), plano.valor_anual, a.id);
            gravarCobrancas(a, a.ciclo + 1, parcelas, resp.cobrancas);
          })();
        } catch (e) { console.error(`[pagamentos] falha ao renovar a assinatura ${a.id}:`, e.message); }
      } else {
        db.prepare("UPDATE assinaturas SET status = 'encerrada', encerrada_em = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?").run(a.fim_ciclo, a.id);
      }
    }
  }
  setTimeout(() => atualizarAssinaturas().catch((e) => console.error('[pagamentos]', e)), 8000);
  setInterval(() => atualizarAssinaturas().catch((e) => console.error('[pagamentos]', e)), 60 * 60 * 1000);

  // Evento normalizado (de webhook ou da baixa manual) → banco
  function aplicarEvento(ev) {
    const cob = ev.provedor_cobranca_id ? db.prepare('SELECT * FROM cobrancas WHERE provedor_cobranca_id = ?').get(ev.provedor_cobranca_id) : null;
    if (ev.tipo === 'cobranca_paga' && cob) {
      db.prepare("UPDATE cobrancas SET status = 'paga', pago_em = ?, valor_pago = ?, forma_pagamento = ? WHERE id = ?")
        .run(ev.pago_em || hoje(), ev.valor ?? cob.valor, ev.forma || null, cob.id);
    } else if (ev.tipo === 'cobranca_vencida' && cob && cob.status === 'pendente') {
      db.prepare("UPDATE cobrancas SET status = 'vencida' WHERE id = ?").run(cob.id);
    } else if (ev.tipo === 'cobranca_estornada' && cob) {
      db.prepare("UPDATE cobrancas SET status = 'estornada' WHERE id = ?").run(cob.id);
    } else if (ev.tipo === 'assinatura_cancelada' && ev.provedor_assinatura_id) {
      db.prepare("UPDATE assinaturas SET renovacao_automatica = 0, status = 'cancelada', cancelada_em = CURRENT_TIMESTAMP, encerrada_em = COALESCE(encerrada_em, CURRENT_TIMESTAMP) WHERE provedor_assinatura_id = ?")
        .run(ev.provedor_assinatura_id);
    } else {
      throw new Error('Evento sem cobrança/assinatura correspondente');
    }
  }

  // Webhook do gateway: grava o evento (sem repetir) e aplica
  app.post('/pagamentos/webhook/:provedor', async (req, res) => {
    const provedor = PROVEDORES[req.params.provedor];
    if (!provedor) return res.status(404).json({ erro: 'Provedor desconhecido' });
    let eventos;
    try { eventos = await provedor.interpretarWebhook(req); } catch (e) {
      console.error(`[pagamentos] webhook recusado (${req.params.provedor}):`, e.message);
      return res.status(400).json({ erro: 'Webhook inválido' });
    }
    const ins = db.prepare('INSERT OR IGNORE INTO pagamentos_eventos (provedor, evento_id, tipo, payload) VALUES (?, ?, ?, ?)');
    for (const ev of eventos) {
      const r = ins.run(req.params.provedor, String(ev.id), ev.tipo, JSON.stringify(req.body ?? {}));
      if (!r.changes) continue; // já recebido
      try {
        aplicarEvento(ev);
        db.prepare('UPDATE pagamentos_eventos SET processado = 1 WHERE id = ?').run(r.lastInsertRowid);
      } catch (e) {
        db.prepare('UPDATE pagamentos_eventos SET erro = ? WHERE id = ?').run(e.message, r.lastInsertRowid);
      }
    }
    await atualizarAssinaturas();
    res.json({ ok: true });
  });

  // ── Cliente: a própria assinatura ──
  app.get('/minha-assinatura', auth(), (req, res) => {
    const a = db.prepare('SELECT a.*, p.nome AS plano FROM assinaturas a JOIN planos p ON p.id = a.plano_id WHERE a.usuario_id = ? ORDER BY a.id DESC LIMIT 1').get(req.user.id);
    if (!a) return res.json(null);
    const cobrancas = db.prepare('SELECT parcela, total_parcelas, valor, vencimento, status, link_pagamento FROM cobrancas WHERE assinatura_id = ? AND ciclo = ? ORDER BY parcela').all(a.id, a.ciclo);
    const pedido = db.prepare("SELECT id, motivo, criado_em FROM pedidos_cancelamento WHERE assinatura_id = ? AND status = 'aberto'").get(a.id) || null;
    res.json({ status: a.status, plano: a.plano, ciclo: a.ciclo, inicio_ciclo: a.inicio_ciclo, fim_ciclo: a.fim_ciclo, renovacao_automatica: !!a.renovacao_automatica, cobrancas, pedido_cancelamento: pedido });
  });

  // ── Master: planos ──
  const validarPlano = (b) => {
    const nome = String(b.nome || '').trim().slice(0, 60);
    const valor = Math.round(Number(b.valor_anual) * 100) / 100;
    const parcelas = Math.min(12, Math.max(1, parseInt(b.parcelas, 10) || 12));
    if (!nome) return { erro: 'Informe o nome do plano' };
    if (!(valor > 0)) return { erro: 'Informe o valor anual' };
    return { nome, valor_anual: valor, parcelas, ativo: b.ativo === undefined ? 1 : (b.ativo ? 1 : 0) };
  };
  app.get('/admin/planos', master(), (req, res) => {
    res.json(db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM assinaturas a WHERE a.plano_id = p.id AND a.status IN ('ativa', 'inadimplente')) AS assinantes
      FROM planos p ORDER BY p.ativo DESC, p.id`).all());
  });
  app.post('/admin/planos', master(), (req, res) => {
    const v = validarPlano(req.body || {});
    if (v.erro) return res.status(400).json(v);
    const r = db.prepare('INSERT INTO planos (nome, valor_anual, parcelas, ativo) VALUES (@nome, @valor_anual, @parcelas, @ativo)').run(v);
    res.status(201).json(db.prepare('SELECT * FROM planos WHERE id = ?').get(r.lastInsertRowid));
  });
  // Mudar o preço vale para os próximos ciclos; as parcelas já geradas não mudam
  app.put('/admin/planos/:id', master(), (req, res) => {
    const v = validarPlano(req.body || {});
    if (v.erro) return res.status(400).json(v);
    db.prepare('UPDATE planos SET nome=@nome, valor_anual=@valor_anual, parcelas=@parcelas, ativo=@ativo WHERE id=@id').run({ ...v, id: req.params.id });
    res.json(db.prepare('SELECT * FROM planos WHERE id = ?').get(req.params.id));
  });

  // ── Indicadores: MRR, ARPU, churn e LTV (definições no topo do arquivo) ──
  function indicadores(dia) {
    const r2 = (v) => Math.round(v * 100) / 100;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const todas = db.prepare(`SELECT a.id, a.usuario_id, a.status, a.valor_ciclo, a.renovacao_automatica, date(a.criado_em) AS inicio,
      date(a.encerrada_em) AS fim, p.parcelas FROM assinaturas a JOIN planos p ON p.id = a.plano_id`).all();
    const mensal = (a) => a.valor_ciclo / (a.parcelas || 12);
    const valendo = (d) => todas.filter((a) => a.inicio <= d && (!a.fim || a.fim > d));
    const mesIdx = (iso) => { const [y, m] = iso.split('-').map(Number); return y * 12 + m - 1; };
    const primeiroDia = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
    const ultimoDia = (i) => { const d = new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)); return d.toISOString().slice(0, 10); };

    const atual = mesIdx(dia);
    const historico = [];
    for (let i = atual - 5; i <= atual; i++) {
      const ini = primeiroDia(i), fim = i === atual ? dia : ultimoDia(i);
      const base = valendo(ini).length;
      const encerradas = todas.filter((a) => a.fim && a.fim >= ini && a.fim <= fim).length;
      historico.push({
        mes: ini.slice(0, 7),
        assinantes_inicio: base,
        novas: todas.filter((a) => a.inicio >= ini && a.inicio <= fim).length,
        encerradas,
        churn: base ? r4(encerradas / base) : null,
        mrr: r2(valendo(fim).reduce((t, a) => t + mensal(a), 0)),
      });
    }
    const vigentes = todas.filter((a) => ['ativa', 'inadimplente'].includes(a.status));
    const mrr = r2(vigentes.reduce((t, a) => t + mensal(a), 0));
    const arpu = vigentes.length ? r2(mrr / vigentes.length) : 0;
    const ultimos3 = historico.slice(-4, -1).map((h) => h.churn).filter((c) => c !== null);
    const churn3m = ultimos3.length ? r4(ultimos3.reduce((t, c) => t + c, 0) / ultimos3.length) : null;
    const pago = db.prepare("SELECT COALESCE(SUM(COALESCE(valor_pago, valor)), 0) AS t, COUNT(DISTINCT usuario_id) AS n FROM cobrancas WHERE status = 'paga'").get();
    return {
      indicadores: {
        mrr, arpu, assinantes: vigentes.length,
        churn_mes: historico.at(-1).churn,
        churn_3m: churn3m,
        ltv: churn3m ? r2(arpu / churn3m) : null,
        receita_media_por_assinante: pago.n ? r2(pago.t / pago.n) : 0,
        renovacoes_desligadas: vigentes.filter((a) => !a.renovacao_automatica).length,
        pedidos_cancelamento_abertos: db.prepare("SELECT COUNT(*) AS n FROM pedidos_cancelamento WHERE status = 'aberto'").get().n,
      },
      historico,
    };
  }

  // ── Master: visão financeira por cliente ──
  app.get('/admin/financeiro', master(), (req, res) => {
    const dia = hoje();
    const mes = dia.slice(0, 7);
    const usuarios = db.prepare('SELECT id, nome, email FROM usuarios ORDER BY nome').all();
    const titular = db.prepare('SELECT nome FROM pessoas WHERE usuario_id = ? ORDER BY id LIMIT 1');
    const ultimaAssinatura = db.prepare('SELECT a.*, p.nome AS plano FROM assinaturas a JOIN planos p ON p.id = a.plano_id WHERE a.usuario_id = ? ORDER BY a.id DESC LIMIT 1');
    const doCiclo = db.prepare('SELECT * FROM cobrancas WHERE assinatura_id = ? AND ciclo = ? ORDER BY parcela');
    const clientes = usuarios.map((u) => {
      const a = ultimaAssinatura.get(u.id);
      const base = { usuario_id: u.id, nome: titular.get(u.id)?.nome || u.nome, email: u.email, assinatura: null };
      if (!a) return base;
      const cs = doCiclo.all(a.id, a.ciclo);
      const pagas = cs.filter((c) => c.status === 'paga');
      const proxima = cs.find((c) => c.status === 'pendente' || c.status === 'vencida');
      const atraso = cs.filter((c) => c.status === 'vencida');
      return {
        ...base,
        assinatura: {
          id: a.id, status: a.status, plano: a.plano, ciclo: a.ciclo, inicio_ciclo: a.inicio_ciclo, fim_ciclo: a.fim_ciclo,
          valor_ciclo: a.valor_ciclo, valor_mensal: Math.round((a.valor_ciclo / (cs.length || 12)) * 100) / 100,
          renovacao_automatica: !!a.renovacao_automatica, provedor: a.provedor,
          parcelas_pagas: pagas.length, total_parcelas: cs.length,
          valor_pago_ciclo: Math.round(pagas.reduce((t, c) => t + (c.valor_pago ?? c.valor), 0) * 100) / 100,
          em_atraso: Math.round(atraso.reduce((t, c) => t + c.valor, 0) * 100) / 100,
          parcelas_em_atraso: atraso.length,
          proximo_vencimento: proxima?.vencimento ?? null, proxima_parcela: proxima?.valor ?? null,
        },
      };
    });
    const ativos = clientes.filter((c) => c.assinatura && STATUS_COM_ACESSO.includes(c.assinatura.status));
    const soma = (sql, ...a) => Math.round((Number(db.prepare(sql).get(...a).t) || 0) * 100) / 100;
    const pedidosAbertos = new Set(db.prepare("SELECT usuario_id FROM pedidos_cancelamento WHERE status = 'aberto'").all().map((r) => r.usuario_id));
    clientes.forEach((c) => { c.pedido_cancelamento = pedidosAbertos.has(c.usuario_id); });
    res.json({
      provedor: provedorAtual(),
      ...indicadores(dia),
      resumo: {
        clientes: usuarios.length,
        assinantes_ativos: ativos.filter((c) => c.assinatura.status === 'ativa').length,
        inadimplentes: ativos.filter((c) => c.assinatura.status === 'inadimplente').length,
        receita_mensal_recorrente: Math.round(ativos.reduce((t, c) => t + c.assinatura.valor_mensal, 0) * 100) / 100,
        recebido_no_mes: soma("SELECT COALESCE(SUM(COALESCE(valor_pago, valor)), 0) AS t FROM cobrancas WHERE status = 'paga' AND substr(pago_em, 1, 7) = ?", mes),
        a_receber_no_mes: soma("SELECT COALESCE(SUM(valor), 0) AS t FROM cobrancas WHERE status IN ('pendente', 'vencida') AND substr(vencimento, 1, 7) = ?", mes),
        em_atraso: soma("SELECT COALESCE(SUM(valor), 0) AS t FROM cobrancas WHERE status = 'vencida'"),
      },
      clientes,
    });
  });

  app.get('/admin/assinaturas/:id/cobrancas', master(), (req, res) => {
    res.json(db.prepare('SELECT * FROM cobrancas WHERE assinatura_id = ? ORDER BY ciclo DESC, parcela').all(req.params.id));
  });

  app.post('/admin/assinaturas', master(), async (req, res) => {
    const { usuario_id, plano_id } = req.body || {};
    const inicio = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.inicio || '')) ? req.body.inicio : hoje();
    const plano = db.prepare('SELECT * FROM planos WHERE id = ? AND ativo = 1').get(plano_id);
    if (!plano) return res.status(400).json({ erro: 'Plano inválido' });
    if (!db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(usuario_id)) return res.status(400).json({ erro: 'Cliente inválido' });
    if (temAssinatura(usuario_id)) return res.status(409).json({ erro: 'Este cliente já tem uma assinatura ativa' });
    try {
      const id = await criarAssinatura(Number(usuario_id), plano, inicio);
      await atualizarAssinaturas();
      res.status(201).json({ id });
    } catch (e) { res.status(502).json({ erro: `Não foi possível criar a assinatura: ${e.message}` }); }
  });

  app.put('/admin/assinaturas/:id', master(), (req, res) => {
    const r = db.prepare('UPDATE assinaturas SET renovacao_automatica = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.body?.renovacao_automatica ? 1 : 0, req.params.id);
    if (!r.changes) return res.status(404).json({ erro: 'Assinatura não encontrada' });
    res.json({ ok: true });
  });

  // Cancela no gateway e no banco. Lança erro se o gateway recusar.
  async function cancelarAssinatura(a, imediato) {
    await (PROVEDORES[a.provedor] || PROVEDORES.manual).cancelarAssinatura({ assinatura: a, imediato });
    db.transaction(() => {
      db.prepare(`UPDATE assinaturas SET renovacao_automatica = 0, cancelada_em = CURRENT_TIMESTAMP, status = ?,
        encerrada_em = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE encerrada_em END, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(imediato ? 'cancelada' : a.status, imediato ? 1 : 0, a.id);
      if (imediato) db.prepare("UPDATE cobrancas SET status = 'cancelada' WHERE assinatura_id = ? AND status IN ('pendente', 'vencida')").run(a.id);
    })();
  }

  app.post('/admin/assinaturas/:id/cancelar', master(), async (req, res) => {
    const a = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(req.params.id);
    if (!a) return res.status(404).json({ erro: 'Assinatura não encontrada' });
    try { await cancelarAssinatura(a, !!req.body?.imediato); }
    catch (e) { return res.status(502).json({ erro: `O gateway recusou o cancelamento: ${e.message}` }); }
    // Pedido aberto deste cliente fica resolvido junto
    db.prepare(`UPDATE pedidos_cancelamento SET status = 'concluido', resolucao = ?, resolvido_em = CURRENT_TIMESTAMP
      WHERE assinatura_id = ? AND status = 'aberto'`).run(req.body?.imediato ? 'cancelar_agora' : 'cancelar_renovacao', a.id);
    res.json({ ok: true });
  });

  // ── Pedidos de cancelamento ──
  const assinaturaVigente = (usuarioId) =>
    db.prepare("SELECT * FROM assinaturas WHERE usuario_id = ? AND status IN ('ativa', 'inadimplente') ORDER BY id DESC LIMIT 1").get(usuarioId);
  function registrarPedido(usuarioId, b, canalPadrao) {
    const a = assinaturaVigente(usuarioId);
    if (!a) return { status: 400, erro: 'Não há assinatura ativa para cancelar' };
    if (!a.renovacao_automatica) return { status: 409, erro: 'A renovação desta assinatura já está cancelada' };
    if (db.prepare("SELECT 1 FROM pedidos_cancelamento WHERE assinatura_id = ? AND status = 'aberto'").get(a.id)) {
      return { status: 409, erro: 'Já existe um pedido de cancelamento em análise' };
    }
    const motivo = MOTIVOS_CANCELAMENTO[b.motivo] ? b.motivo : 'outro';
    const canal = CANAIS_CANCELAMENTO.includes(b.canal) ? b.canal : canalPadrao;
    const r = db.prepare('INSERT INTO pedidos_cancelamento (usuario_id, assinatura_id, motivo, detalhe, canal) VALUES (?, ?, ?, ?, ?)')
      .run(usuarioId, a.id, motivo, String(b.detalhe || '').trim().slice(0, 1000), canal);
    return { pedido: db.prepare('SELECT * FROM pedidos_cancelamento WHERE id = ?').get(r.lastInsertRowid) };
  }

  // Cliente pede pelo app
  app.post('/minha-assinatura/cancelamento', auth(), (req, res) => {
    const r = registrarPedido(req.user.id, req.body || {}, 'app');
    if (r.erro) return res.status(r.status).json({ erro: r.erro });
    res.status(201).json(r.pedido);
  });
  app.get('/cancelamento/motivos', auth(), (req, res) => res.json(MOTIVOS_CANCELAMENTO));

  // Master: lista, registra (pedido recebido por WhatsApp ou atendimento) e resolve
  app.get('/admin/cancelamentos', master(), (req, res) => {
    const status = ['aberto', 'concluido', 'revertido'].includes(req.query.status) ? req.query.status : null;
    res.json(db.prepare(`SELECT pc.*, u.email, COALESCE((SELECT nome FROM pessoas WHERE usuario_id = pc.usuario_id ORDER BY id LIMIT 1), u.nome) AS nome,
        a.fim_ciclo, a.status AS status_assinatura
      FROM pedidos_cancelamento pc JOIN usuarios u ON u.id = pc.usuario_id JOIN assinaturas a ON a.id = pc.assinatura_id
      ${status ? 'WHERE pc.status = ?' : ''} ORDER BY pc.status = 'aberto' DESC, pc.criado_em DESC`).all(...(status ? [status] : [])));
  });
  app.post('/admin/cancelamentos', master(), (req, res) => {
    const r = registrarPedido(Number(req.body?.usuario_id), req.body || {}, 'atendimento');
    if (r.erro) return res.status(r.status).json({ erro: r.erro });
    res.status(201).json(r.pedido);
  });
  app.post('/admin/cancelamentos/:id/resolver', master(), async (req, res) => {
    const p = db.prepare("SELECT * FROM pedidos_cancelamento WHERE id = ? AND status = 'aberto'").get(req.params.id);
    if (!p) return res.status(404).json({ erro: 'Pedido não encontrado ou já resolvido' });
    const acao = req.body?.acao;
    if (!['cancelar_renovacao', 'cancelar_agora', 'revertido'].includes(acao)) return res.status(400).json({ erro: 'Ação inválida' });
    if (acao !== 'revertido') {
      const a = db.prepare('SELECT * FROM assinaturas WHERE id = ?').get(p.assinatura_id);
      try { await cancelarAssinatura(a, acao === 'cancelar_agora'); }
      catch (e) { return res.status(502).json({ erro: `O gateway recusou o cancelamento: ${e.message}` }); }
    }
    db.prepare(`UPDATE pedidos_cancelamento SET status = ?, resolucao = ?, observacao = ?, resolvido_em = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(acao === 'revertido' ? 'revertido' : 'concluido', acao, String(req.body?.observacao || '').slice(0, 500), p.id);
    res.json({ ok: true });
  });

  // Baixa manual de uma parcela (provedor manual, ou pagamento recebido fora do gateway)
  app.post('/admin/cobrancas/:id/baixa', master(), async (req, res) => {
    const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ erro: 'Parcela não encontrada' });
    if (!['pendente', 'vencida'].includes(c.status)) return res.status(409).json({ erro: 'Esta parcela não está em aberto' });
    const pagoEm = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.pago_em || '')) ? req.body.pago_em : hoje();
    db.prepare("UPDATE cobrancas SET status = 'paga', pago_em = ?, valor_pago = ?, forma_pagamento = ? WHERE id = ?")
      .run(pagoEm, c.valor, String(req.body?.forma || 'manual').slice(0, 30), c.id);
    await atualizarAssinaturas();
    res.json({ ok: true });
  });
  app.post('/admin/cobrancas/:id/desfazer-baixa', master(), async (req, res) => {
    const c = db.prepare('SELECT * FROM cobrancas WHERE id = ?').get(req.params.id);
    if (!c || c.status !== 'paga') return res.status(409).json({ erro: 'Esta parcela não está paga' });
    db.prepare("UPDATE cobrancas SET status = 'pendente', pago_em = NULL, valor_pago = NULL, forma_pagamento = NULL WHERE id = ?").run(c.id);
    await atualizarAssinaturas();
    res.json({ ok: true });
  });

  return { temAssinatura, atualizarAssinaturas };
};

module.exports.PROVEDORES = PROVEDORES;
