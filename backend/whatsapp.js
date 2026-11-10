// ── WhatsApp: entrada de mensagens, consultas, alertas configuráveis e fila de saída ──
//
// O Zevem não fala direto com o WhatsApp: um serviço de integração (provedor oficial / BSP)
// recebe as mensagens, transcreve os áudios e chama a API abaixo. Contrato completo na documentação
// da integração. Resumo:
//
//   POST /integracao/whatsapp/mensagens        mensagem recebida (texto ou áudio já transcrito)
//                                              → devolve o texto da resposta, que o integrador envia
//   GET  /integracao/whatsapp/saida            avisos programados prontos para envio (fila)
//   POST /integracao/whatsapp/saida/:id/status confirma o envio (enviado | falhou)
//   GET  /integracao/whatsapp/saude            teste de conexão e do token
//
// Autenticação das rotas /integracao: "Authorization: Bearer <WHATSAPP_INTEGRACAO_TOKEN>".
// Sem a variável, a integração fica desligada (503) e os avisos seguem só registrados no app.
//
// No app (usuário logado): GET/PUT /alertas/config, POST /whatsapp/simular, GET /whatsapp/mensagens.

const crypto = require('crypto');
const { cifrar, decifrar, indice } = require('./cripto');
const Anthropic = require('@anthropic-ai/sdk');

// Modelo da interpretação das mensagens. Padrão: Claude Opus 5.5 com esforço baixo (classificação curta).
// Para baratear, dá para trocar por WHATSAPP_MODELO_IA=claude-haiku-5-5 (ver estimativa de custos).
const MODELO_PADRAO = 'claude-opus-5-5';
// Preço por 1M de tokens (US$), para estimar o custo de cada mensagem no histórico
const PRECOS_IA = {
  'claude-opus-5-5': { entrada: 4, saida: 20, cache_leitura: 0.2 },
  'claude-sonnet-5-5': { entrada: 2, saida: 10, cache_leitura: 0.2 },
  'claude-haiku-5-5': { entrada: 0.1, saida: 0.5, cache_leitura: 0.01 },
};
// Fallback do servidor em caso de recusa: só nos modelos que aceitam o parâmetro
const ACEITA_FALLBACK = /^claude-(opus|sonnet|fable)-/;

const ROTULOS_CATEGORIA = {
  moradia: 'Moradia', transporte: 'Transporte', 'vida-saude': 'Vida e Saúde', 'lazer-doacoes': 'Lazer',
  alimentacao: 'Alimentação fora de casa', assinaturas: 'Assinaturas', dependentes: 'Dependentes',
  empresa: 'Empresa', 'nao-identificado': 'Não Identificado',
};
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// ── Tipos de alerta ──
// `template`: nome sugerido do modelo de mensagem a aprovar na Meta (mensagens que a empresa inicia
// fora da janela de 24h precisam de template). As variáveis de cada aviso seguem em `variaveis`.
const TIPOS_ALERTA = {
  conta_vencendo: {
    titulo: 'Contas a vencer',
    descricao: 'Avisa antes do vencimento das contas com dia fixo pagas fora do cartão. Contas anuais avisam no dia 1º do mês anterior e do próprio mês.',
    template: 'ag_conta_vencendo',
    padrao: { ativo: true, parametros: { dias_antes: [3, 0] } },
  },
  fatura_fecha: {
    titulo: 'Fechamento da fatura',
    descricao: 'Avisa antes do fechamento da fatura de cada cartão.',
    template: 'ag_fatura_fecha',
    padrao: { ativo: true, parametros: { dias_antes: 1 } },
  },
  melhor_dia_compra: {
    titulo: 'Melhor dia de compra',
    descricao: 'Avisa no dia seguinte ao fechamento: a compra só será paga na fatura do mês seguinte.',
    template: 'ag_melhor_dia_compra',
    padrao: { ativo: true, parametros: {} },
  },
  fatura_vence: {
    titulo: 'Vencimento da fatura',
    descricao: 'Avisa antes do vencimento da fatura de cada cartão.',
    template: 'ag_fatura_vence',
    padrao: { ativo: true, parametros: { dias_antes: [3, 0] } },
  },
  saldo_pos_lancamento: {
    titulo: 'Saldo após cada lançamento',
    descricao: 'Ao lançar um gasto pelo WhatsApp, a resposta já diz quanto ainda dá para gastar naquele item. Pode avisar também a outra pessoa da conta.',
    template: 'ag_lancamento_outra_pessoa',
    padrao: { ativo: true, parametros: { avisar_outras_pessoas: false } },
  },
  meta_atingida: {
    titulo: 'Meta perto do limite',
    descricao: 'Avisa quando um item chega a uma parte da meta do mês (ou do limite anual, nos eventuais).',
    template: 'ag_meta_atingida',
    padrao: { ativo: true, parametros: { percentuais: [80, 100] } },
  },
  limite_programado: {
    titulo: 'Quanto ainda posso gastar',
    descricao: 'Em dias e horário escolhidos, informa o saldo do mês dos itens selecionados (ex.: sexta à tarde, quanto sobra para comer fora no fim de semana).',
    template: 'ag_limite_programado',
    padrao: { ativo: false, parametros: { dias_semana: [5], hora: 17, itens: [] } }, // itens vazio = Alimentação fora de casa
  },
};

// Texto de cada alerta, editável pelo master (menu Master › Alertas). Entre chaves, as variáveis do
// aviso; {nome} é o primeiro nome de quem recebe. Sem texto salvo, vale a mensagem montada no código
// (equivalente ao padrão abaixo). Muda o texto do histórico e das mensagens dentro da janela de 24h;
// fora dela o WhatsApp usa o template aprovado na Meta, com as mesmas variáveis.
const TEXTOS_ALERTA = {
  conta_vencendo: {
    padrao: '📅 {conta} vence {quando}. Valor previsto: {valor}.',
    variaveis: { nome: 'Maria', conta: 'Luz', quando: 'em 3 dias, 24/out', vencimento: '24/out', valor: 'R$ 230' },
  },
  fatura_fecha: {
    padrao: '💳 A fatura do {cartao} fecha {quando} ({fechamento}). Compras feitas depois do fechamento só entram na fatura seguinte.',
    variaveis: { nome: 'Maria', cartao: 'Nubank', quando: 'amanhã', fechamento: '22/out' },
  },
  melhor_dia_compra: {
    padrao: '🛍️ Hoje é o melhor dia para comprar no {cartao}: a fatura acabou de fechar, então a compra só será paga em {pagamento}.',
    variaveis: { nome: 'Maria', cartao: 'Nubank', pagamento: '05/dez' },
  },
  fatura_vence: {
    padrao: '💳 A fatura do {cartao} vence {quando}.',
    variaveis: { nome: 'Maria', cartao: 'Nubank', quando: 'em 3 dias, 05/nov', vencimento: '05/nov' },
  },
  meta_atingida: {
    padrao: '⚠️ {item} já usou {percentual}% do planejado ({realizado} de {meta}). Saldo: {disponivel}.',
    variaveis: { nome: 'Maria', item: 'Almoço / Lanches / Jantar', percentual: '86', realizado: 'R$ 192', meta: 'R$ 223', disponivel: 'R$ 31' },
  },
  limite_programado: {
    padrao: '💡 Até o fim de {mes} ainda dá para gastar {total} nestes itens (cerca de {por_dia} por dia):\n{lista}',
    variaveis: { nome: 'Maria', mes: 'outubro', total: 'R$ 140', por_dia: 'R$ 13', lista: '• Almoço / Lanches / Jantar: ainda pode gastar R$ 140 (usou R$ 83 da meta de R$ 223 do mês).' },
  },
  saldo_pos_lancamento: {
    padrao: '🧾 {pessoa} lançou {valor} em {item}. Saldo do item: {saldo}.',
    variaveis: { nome: 'Maria', pessoa: 'João', valor: 'R$ 45', item: 'Almoço / Lanches / Jantar', saldo: 'R$ 95' },
  },
};
// O WhatsApp entrega o número com DDI (55) e, em alguns celulares, sem o 9 depois do DDD. A chave
// de comparação é DDD + últimos 8 dígitos, que bate nos dois formatos.
function chaveTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return '';
  return d.slice(0, 2) + d.slice(-8);
}

const preencherTexto = (texto, vars) => String(texto).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));

module.exports = function registrarWhatsapp(ctx) {
  const {
    app, db, auth, interpretarMensagem, identificarItem, dividirEmParcelas, somarMeses,
    CATEGORIA_NI, agoraBrasilia, normalizarTexto, iaLimiter,
  } = ctx;

  // ── Tabelas ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alertas_config (
      usuario_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      ativo INTEGER NOT NULL,
      parametros TEXT NOT NULL DEFAULT '{}',     -- JSON, campos por tipo
      destinatarios TEXT NOT NULL DEFAULT '"todos"', -- JSON: "todos" ou [pessoa_id, ...]
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (usuario_id, tipo)
    );
    CREATE TABLE IF NOT EXISTS whatsapp_mensagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      pessoa_id INTEGER,
      telefone TEXT NOT NULL DEFAULT '',
      mensagem_id TEXT,            -- id da mensagem no provedor (evita processar duas vezes)
      canal TEXT NOT NULL DEFAULT 'whatsapp', -- whatsapp | simulador
      tipo TEXT NOT NULL DEFAULT 'texto',     -- texto | audio
      texto TEXT NOT NULL DEFAULT '',
      intencao TEXT,               -- lancamento | consulta | outro | ...
      acao TEXT,                   -- resultado: lancado | suspenso | consulta | ajuda | numero_desconhecido | ...
      resposta TEXT,
      detalhes TEXT,               -- JSON
      modelo TEXT,
      tokens_entrada INTEGER DEFAULT 0,
      tokens_saida INTEGER DEFAULT 0,
      tokens_cache INTEGER DEFAULT 0,
      custo_usd REAL DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wpp_mensagem_id ON whatsapp_mensagens(mensagem_id) WHERE mensagem_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_wpp_usuario ON whatsapp_mensagens(usuario_id, criado_em);
  `);
  // Quem lançou (pessoa da conta): o casal lança pelo WhatsApp e tudo cai no mesmo orçamento
  try { db.prepare('ALTER TABLE lancamentos_gastos ADD COLUMN pessoa_id INTEGER').run(); } catch {}
  try { db.prepare('ALTER TABLE gastos_suspensos ADD COLUMN pessoa_id INTEGER').run(); } catch {}
  // Avisos: pessoa destinatária, template do WhatsApp e reserva na fila de saída
  try { db.prepare('ALTER TABLE avisos ADD COLUMN pessoa_id INTEGER').run(); } catch {}
  try { db.prepare("ALTER TABLE avisos ADD COLUMN template TEXT DEFAULT ''").run(); } catch {}
  try { db.prepare("ALTER TABLE avisos ADD COLUMN variaveis TEXT DEFAULT '{}'").run(); } catch {}
  try { db.prepare('ALTER TABLE avisos ADD COLUMN reservado_em DATETIME').run(); } catch {}
  try { db.prepare('ALTER TABLE avisos ADD COLUMN mensagem_id_provedor TEXT').run(); } catch {}

  const integracaoAtiva = () => !!process.env.WHATSAPP_INTEGRACAO_TOKEN;

  db.exec(`CREATE TABLE IF NOT EXISTS config_app (chave TEXT PRIMARY KEY, valor TEXT NOT NULL, atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // Textos personalizados pelo master: { tipo: texto }
  const textosPersonalizados = () => {
    try { return JSON.parse(db.prepare("SELECT valor FROM config_app WHERE chave = 'textos_alertas'").get()?.valor || '{}'); } catch { return {}; }
  };

  // ── Telefones ──
  // Só telefone confirmado (a pessoa mandou o código pelo próprio WhatsApp) identifica quem escreve e
  // recebe alertas. A busca é pelo índice (HMAC), o número fica cifrado no banco.
  function pessoaPorTelefone(telefone) {
    const chave = chaveTelefone(telefone);
    if (!chave) return [];
    return db.prepare('SELECT id, usuario_id, nome, telefone FROM pessoas WHERE telefone_indice = ? AND telefone_verificado = 1').all(indice(chave))
      .map((p) => ({ ...p, telefone: decifrar(p.telefone) }));
  }

  // ── Configuração dos alertas ──
  const lerJson = (t, padrao) => { try { return JSON.parse(t); } catch { return padrao; } };
  function configAlertas(usuarioId) {
    const salvas = new Map(db.prepare('SELECT * FROM alertas_config WHERE usuario_id = ?').all(usuarioId).map((r) => [r.tipo, r]));
    return Object.fromEntries(Object.entries(TIPOS_ALERTA).map(([tipo, def]) => {
      const s = salvas.get(tipo);
      return [tipo, {
        tipo,
        ativo: s ? !!s.ativo : def.padrao.ativo,
        parametros: { ...def.padrao.parametros, ...(s ? lerJson(s.parametros, {}) : {}) },
        destinatarios: s ? lerJson(s.destinatarios, 'todos') : 'todos',
      }];
    }));
  }

  // Pessoas que recebem um alerta (só quem tem telefone)
  function destinatariosAlerta(usuarioId, cfg) {
    const pessoas = db.prepare("SELECT id, nome, telefone FROM pessoas WHERE usuario_id = ? AND telefone_verificado = 1 AND TRIM(COALESCE(telefone, '')) <> '' ORDER BY id").all(usuarioId);
    const lista = Array.isArray(cfg.destinatarios) ? new Set(cfg.destinatarios.map(Number)) : null;
    return pessoas.filter((p) => !lista || lista.has(p.id)).map((p) => ({ ...p, telefone: decifrar(p.telefone), destino: decifrar(p.telefone).replace(/\D/g, '') }));
  }

  function validarConfig(tipo, body) {
    const def = TIPOS_ALERTA[tipo];
    const p = { ...def.padrao.parametros, ...(body.parametros || {}) };
    const dias = (v) => [...new Set((Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 30))].sort((a, b) => b - a);
    if ('dias_antes' in def.padrao.parametros) {
      p.dias_antes = Array.isArray(def.padrao.parametros.dias_antes) ? dias(p.dias_antes) : (dias(p.dias_antes)[0] ?? def.padrao.parametros.dias_antes);
    }
    if (tipo === 'meta_atingida') {
      p.percentuais = [...new Set((p.percentuais || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 200))].sort((a, b) => a - b);
    }
    if (tipo === 'limite_programado') {
      p.dias_semana = [...new Set((p.dias_semana || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
      p.hora = Math.min(22, Math.max(8, Number.isInteger(Number(p.hora)) ? Number(p.hora) : 17));
      p.itens = [...new Set((p.itens || []).map(Number).filter(Number.isInteger))];
    }
    if (tipo === 'saldo_pos_lancamento') p.avisar_outras_pessoas = !!p.avisar_outras_pessoas;
    const dest = body.destinatarios === 'todos' || !Array.isArray(body.destinatarios) ? 'todos' : body.destinatarios.map(Number).filter(Number.isInteger);
    return { ativo: body.ativo === undefined ? def.padrao.ativo : !!body.ativo, parametros: p, destinatarios: dest };
  }

  // ── Saldos (mesma regra da Gestão de Pagamentos) ──
  // Mensais: meta do mês − realizado no mês. Eventuais: limite anual − a janela de 12 meses mais cheia
  // que contém o mês (cada parcela pesa no mês em que cai).
  const indiceMes = (iso) => { const [a, m] = iso.split('-').map(Number); return a * 12 + (m - 1); };
  const chaveMes = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  const ehEventual = (g) => String(g.classe || '').startsWith('Eventual');

  function saldoItem(usuarioId, g, mes) {
    const meta = Number(g.valor) || 0;
    if (!ehEventual(g)) {
      const realizado = db.prepare("SELECT COALESCE(SUM(valor), 0) AS t FROM lancamentos_gastos WHERE usuario_id = ? AND gasto_id = ? AND substr(data, 1, 7) = ?").get(usuarioId, g.id, mes).t;
      return { item: g, eventual: false, meta, realizado: arred(realizado), disponivel: arred(meta - realizado) };
    }
    const porMes = new Map(db.prepare(`SELECT substr(data, 1, 7) AS m, SUM(valor) AS t FROM lancamentos_gastos
      WHERE usuario_id = ? AND gasto_id = ? GROUP BY m`).all(usuarioId, g.id).map((r) => [indiceMes(r.m), r.t]));
    const alvo = indiceMes(mes);
    let pior = 0;
    for (let ini = alvo - 11; ini <= alvo; ini++) {
      let soma = 0;
      for (let k = ini; k < ini + 12; k++) soma += porMes.get(k) ?? 0;
      pior = Math.max(pior, soma);
    }
    return { item: g, eventual: true, meta, realizado: arred(pior), disponivel: arred(meta - pior) };
  }
  const arred = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const percentual = (s) => (s.meta ? Math.round((s.realizado / s.meta) * 100) : 0);
  const passou = (s) => percentual(s) > 100;

  function itensDoUsuario(usuarioId) {
    return db.prepare('SELECT id, categoria, descricao, classe, valor FROM gastos WHERE usuario_id = ? AND TRIM(descricao) <> \'\' ORDER BY id').all(usuarioId);
  }
  function rotulosCategorias(usuarioId) {
    const pessoas = db.prepare('SELECT nome FROM pessoas WHERE usuario_id = ? ORDER BY id').all(usuarioId);
    const r = { ...ROTULOS_CATEGORIA };
    pessoas.forEach((p, i) => { r[`pessoa-${i + 1}`] = `Gastos pessoais de ${String(p.nome).split(' ')[0]}`; });
    return r;
  }

  // ── Formatação das respostas ──
  const moeda = (v) => {
    const n = Number(v) || 0;
    const centavos = Math.round(Math.abs(n) * 100) % 100 !== 0;
    return `R$ ${Math.abs(n).toLocaleString('pt-BR', { minimumFractionDigits: centavos ? 2 : 0, maximumFractionDigits: centavos ? 2 : 0 })}`;
  };
  // Valor com sinal, para variáveis de template ("−R$ 50" quando passou da meta)
  const moedaSinal = (v) => `${Number(v) < 0 ? '−' : ''}${moeda(v)}`;
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const nomeMes = (mes) => { const [a, m] = mes.split('-').map(Number); return `${MESES[m - 1]}/${a}`; };
  const dataBr = (iso) => { const [a, m, d] = iso.split('-'); return `${d}/${m}${a !== agoraBrasilia().hoje.slice(0, 4) ? '/' + a : ''}`; };
  const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || '';

  function frasesSaldo(s, sufixo = '') {
    const nome = s.item.descricao;
    if (!s.meta) {
      return s.eventual
        ? `${nome}: sem limite anual definido. Comprometido em 12 meses (com parcelas futuras): ${moeda(s.realizado)}.`
        : `${nome}: sem meta definida${sufixo}. Gasto no mês até agora: ${moeda(s.realizado)}.`;
    }
    const base = s.eventual ? `do limite anual de ${moeda(s.meta)}` : `da meta de ${moeda(s.meta)} do mês`;
    // Mesma regra da tela: quem mostra até 100% (ex.: R$ 158,33 numa meta de R$ 158) atingiu, não passou
    if (s.disponivel < 0 && !passou(s)) return `${nome}: atingiu ${base} (usou ${moeda(s.realizado)})${sufixo}.`;
    if (s.disponivel >= 0) return `${nome}: ainda pode gastar ${moeda(s.disponivel)}${sufixo} (usou ${moeda(s.realizado)} ${base}).`;
    return `${nome}: passou ${moeda(-s.disponivel)} ${base}${sufixo} (usou ${moeda(s.realizado)}).`;
  }

  const AJUDA = 'Para lançar um gasto, mande por exemplo "mercado 120", "uber 23 ontem" ou "tv 1.200 em 10x".\n'
    + 'Para consultar: "quanto ainda posso gastar com restaurante?" ou "quanto gastei com roupas este mês?".';

  // ── Interpretação por IA ──
  const SCHEMA_IA = {
    type: 'object', additionalProperties: false,
    required: ['intencao', 'lancamentos', 'consulta', 'resposta_livre'],
    properties: {
      intencao: { type: 'string', enum: ['lancamento', 'consulta', 'outro'] },
      lancamentos: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['descricao', 'valor', 'data', 'item_id', 'confianca', 'parcelas'],
          properties: {
            descricao: { type: 'string' },
            valor: { type: 'number' },
            data: { type: 'string' },
            item_id: { type: 'integer' },
            confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
            parcelas: { type: 'integer' },
          },
        },
      },
      consulta: {
        type: 'object', additionalProperties: false,
        required: ['tipo', 'item_ids', 'categorias', 'mes_de', 'mes_ate', 'termo'],
        properties: {
          tipo: { type: 'string', enum: ['saldo_disponivel', 'total_gasto', 'nenhuma'] },
          item_ids: { type: 'array', items: { type: 'integer' } },
          categorias: { type: 'array', items: { type: 'string' } },
          mes_de: { type: 'string' },
          mes_ate: { type: 'string' },
          termo: { type: 'string' },
        },
      },
      resposta_livre: { type: 'string' },
    },
  };

  const INSTRUCOES_IA = `Você interpreta mensagens de WhatsApp enviadas ao Zevem, um app brasileiro de orçamento doméstico. Quem escreve é uma pessoa da família, em português informal, por texto ou áudio transcrito (pode haver erros de transcrição).

Classifique a intenção:
- "lancamento": a pessoa informa um ou mais gastos que fez ("almoço 45", "paguei a luz 230", "uber 23 e café 8", "comprei tênis 600 em 3x").
- "consulta": a pessoa pergunta sobre o orçamento ("quanto ainda posso gastar com restaurante?", "quanto gastei com roupas em setembro?").
- "outro": saudações, agradecimentos, pedidos de ajuda ou qualquer outra coisa.

Para cada gasto em "lancamentos":
- descricao: o que foi comprado ou o estabelecimento, curto, como a pessoa escreveu.
- valor: o valor TOTAL em reais (número). Se a pessoa não disse o valor, use 0.
- data: AAAA-MM-DD. Use a data de hoje se não houver indicação; "ontem", "sexta passada", "dia 5" etc. relativos à data de hoje informada.
- parcelas: número de parcelas ("em 10x" = 10); 1 quando à vista.
- item_id: o item do orçamento em que o gasto se encaixa, da lista abaixo. Use 0 se nenhum servir.
- confianca: "alta" só quando o item é claramente o certo; "media" quando há dúvida razoável entre itens; "baixa" quando é um palpite.
Itens de categorias de gastos pessoais pertencem a uma pessoa: prefira o item da pessoa que está escrevendo quando o gasto for pessoal dela.

Para "consulta":
- tipo: "saldo_disponivel" (quanto ainda pode gastar) ou "total_gasto" (quanto já gastou). "nenhuma" se não for consulta.
- item_ids e categorias: os itens e/ou categorias (ids da lista) a que a pergunta se refere. Prefira a categoria quando a pergunta for ampla ("alimentação", "lazer") e itens quando for específica ("uber", "roupas"). Listas vazias se a pergunta for sobre o total geral.
- mes_de e mes_ate: período AAAA-MM. Sem indicação, use o mês atual nos dois.
- termo: o assunto da pergunta como a pessoa escreveu (ex.: "alimentação fora de casa").

Em "resposta_livre", só para intencao "outro": uma resposta curta, cordial, em português, explicando o que dá para fazer quando fizer sentido. Nos outros casos, deixe vazio.
Preencha todos os campos; use listas vazias, 0 e "" no que não se aplicar.`;

  function contextoUsuario(usuarioId) {
    const rotulos = rotulosCategorias(usuarioId);
    const itens = itensDoUsuario(usuarioId).filter((g) => g.categoria !== CATEGORIA_NI);
    const cats = [...new Set(itens.map((g) => g.categoria))];
    return `Categorias (id | nome):\n${cats.map((c) => `${c} | ${rotulos[c] || c}`).join('\n')}\n\n`
      + `Itens do orçamento (item_id | categoria | item | tipo):\n${itens.map((g) => `${g.id} | ${g.categoria} | ${g.descricao} | ${g.classe || '-'}`).join('\n')}`;
  }

  async function interpretarComIA(usuarioId, pessoa, texto) {
    const modelo = process.env.WHATSAPP_MODELO_IA || MODELO_PADRAO;
    const { hoje } = agoraBrasilia();
    const diaSemana = DIAS_SEMANA[new Date(`${hoje}T12:00:00Z`).getUTCDay()];
    const client = new Anthropic();
    const pedido = {
      model: modelo,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA_IA } },
      // Instruções fixas + itens do usuário (mudam pouco): em cache, para baratear as próximas mensagens
      system: [
        { type: 'text', text: INSTRUCOES_IA },
        { type: 'text', text: contextoUsuario(usuarioId), cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: `Hoje: ${hoje} (${diaSemana}). Quem escreve: ${pessoa?.nome || 'titular'}.\n<mensagem>\n${texto}\n</mensagem>` }],
    };
    if (ACEITA_FALLBACK.test(modelo)) Object.assign(pedido, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    const msg = ACEITA_FALLBACK.test(modelo) ? await client.beta.messages.create(pedido) : await client.messages.create(pedido);
    const uso = {
      modelo,
      tokens_entrada: (msg.usage?.input_tokens || 0) + (msg.usage?.cache_creation_input_tokens || 0),
      tokens_saida: msg.usage?.output_tokens || 0,
      tokens_cache: msg.usage?.cache_read_input_tokens || 0,
    };
    const p = PRECOS_IA[modelo] || PRECOS_IA[MODELO_PADRAO];
    uso.custo_usd = (uso.tokens_entrada * p.entrada + (msg.usage?.cache_creation_input_tokens || 0) * p.entrada * 0.25
      + uso.tokens_cache * p.cache_leitura + uso.tokens_saida * p.saida) / 1e6;
    if (msg.stop_reason === 'refusal') return { resultado: null, uso };
    const t = msg.content.find((b) => b.type === 'text')?.text;
    return { resultado: JSON.parse(t || '{}'), uso };
  }

  // Sinais de pergunta: não lança pelo atalho de regras
  const PARECE_PERGUNTA = /\?|\b(quanto|qual|quais|posso|saldo|resta|sobra|me (diga|fala|mostra)|consulta)\b/i;

  // ── Lançamento ──
  function lancar(usuarioId, pessoaId, g, { descricao, valor, data, parcelas }, canal) {
    const origem = 'whatsapp';
    const n = Math.min(Math.max(parseInt(parcelas, 10) || 1, 1), 60);
    if (n === 1) {
      db.prepare('INSERT INTO lancamentos_gastos (usuario_id, gasto_id, data, valor, descricao, origem, pessoa_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(usuarioId, g.id, data, valor, descricao, origem, pessoaId);
      return;
    }
    const grupo = `${usuarioId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const ins = db.prepare(`INSERT INTO lancamentos_gastos (usuario_id, gasto_id, data, valor, descricao, origem, recorrencia_grupo, parcela, total_parcelas, repeticao, pessoa_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'parcelado', ?)`);
    dividirEmParcelas(valor, n).forEach((v, i) => ins.run(usuarioId, g.id, somarMeses(data, i), v, descricao, origem, grupo, i + 1, n, pessoaId));
  }

  function suspender(usuarioId, pessoaId, textoOriginal, { descricao, valor, data, item_id, parcelas }) {
    const total = parseInt(parcelas, 10) > 1 ? parseInt(parcelas, 10) : null;
    db.prepare(`INSERT INTO gastos_suspensos (usuario_id, texto_original, valor, data, descricao, gasto_sugerido_id, origem, pessoa_id, parcela, total_parcelas)
      VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?)`)
      .run(usuarioId, textoOriginal, valor > 0 ? (total ? arred(valor / total) : valor) : null, data, descricao, item_id || null, pessoaId, total ? 1 : null, total);
  }

  const dataValida = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d));

  // Processa os gastos de uma mensagem: lança os que estão claros, deixa em suspenso o resto
  function processarLancamentos(usuarioId, pessoa, texto, gastos, cfg) {
    const itens = new Map(itensDoUsuario(usuarioId).map((g) => [g.id, g]));
    const { hoje } = agoraBrasilia();
    const linhas = [];
    const detalhes = [];
    const avisosOutros = [];
    for (const l of gastos) {
      const valor = arred(l.valor);
      const data = dataValida(l.data) ? l.data : hoje;
      const g = itens.get(Number(l.item_id));
      const claro = g && g.categoria !== CATEGORIA_NI && valor > 0 && l.confianca === 'alta';
      if (!claro) {
        suspender(usuarioId, pessoa?.id ?? null, texto, { ...l, valor, data });
        detalhes.push({ resultado: 'suspenso', descricao: l.descricao, valor, motivo: valor > 0 ? 'item_incerto' : 'sem_valor' });
        linhas.push(`⏸️ "${l.descricao || texto}"${valor > 0 ? ` (${moeda(valor)})` : ''} ficou em suspenso: ${valor > 0 ? 'não tive certeza do item' : 'faltou o valor'}. Confira em Gestão de Pagamentos › Em suspenso.`);
        continue;
      }
      lancar(usuarioId, pessoa?.id ?? null, g, { descricao: l.descricao, valor, data, parcelas: l.parcelas });
      const n = parseInt(l.parcelas, 10) > 1 ? parseInt(l.parcelas, 10) : 1;
      const quando = data === hoje ? 'hoje' : dataBr(data);
      let linha = `✅ Lancei ${moeda(valor)}${n > 1 ? ` em ${n}x` : ''} em ${g.descricao} (${quando}).`;
      const s = saldoItem(usuarioId, g, data.slice(0, 7));
      if (cfg.saldo_pos_lancamento.ativo) linha += `\n${frasesSaldo(s)}`;
      linhas.push(linha);
      detalhes.push({ resultado: 'lancado', item_id: g.id, item: g.descricao, valor, data, parcelas: n, saldo: { meta: s.meta, realizado: s.realizado, disponivel: s.disponivel } });
      avisosOutros.push({ g, s, valor, n });
    }
    // Avisa a(s) outra(s) pessoa(s) da conta, se configurado
    if (cfg.saldo_pos_lancamento.ativo && cfg.saldo_pos_lancamento.parametros.avisar_outras_pessoas) {
      for (const { g, s, valor, n } of avisosOutros) {
        const mensagem = `🧾 ${primeiroNome(pessoa?.nome) || 'Alguém da conta'} lançou ${moeda(valor)}${n > 1 ? ` em ${n}x` : ''} em ${g.descricao}. ${frasesSaldo(s)}`;
        registrarAvisoImediato(usuarioId, cfg.saldo_pos_lancamento, 'saldo_pos_lancamento', `lanc:${g.id}:${Date.now()}`, `${g.descricao}: novo lançamento`, mensagem,
          { pessoa: primeiroNome(pessoa?.nome) || 'Alguém da conta', valor: moeda(valor), item: g.descricao, saldo: moedaSinal(s.disponivel) }, pessoa?.id);
      }
    }
    const lancados = detalhes.filter((d) => d.resultado === 'lancado').length;
    return { acao: lancados === detalhes.length ? 'lancado' : lancados ? 'parcial' : 'suspenso', resposta: linhas.join('\n\n'), detalhes };
  }

  // ── Consulta ──
  function responderConsulta(usuarioId, c) {
    const { hoje } = agoraBrasilia();
    const mesAtual = hoje.slice(0, 7);
    const itens = itensDoUsuario(usuarioId);
    const porId = new Map(itens.map((g) => [g.id, g]));
    const rotulos = rotulosCategorias(usuarioId);
    const alvosItens = (c.item_ids || []).map(Number).map((id) => porId.get(id)).filter(Boolean);
    const alvosCats = (c.categorias || []).filter((cat) => itens.some((g) => g.categoria === cat));
    const termo = String(c.termo || '').trim();

    if (c.tipo === 'saldo_disponivel') {
      if (!alvosItens.length && !alvosCats.length) {
        return { acao: 'consulta_sem_alvo', resposta: `Não encontrei ${termo ? `"${termo}"` : 'o que você procura'} no seu orçamento. Tente o nome de um item ou de uma categoria, como "restaurante" ou "lazer".` };
      }
      const linhas = [];
      const detalhes = [];
      for (const cat of alvosCats) {
        const saldos = itens.filter((g) => g.categoria === cat && g.valor > 0).map((g) => saldoItem(usuarioId, g, mesAtual));
        const disp = arred(saldos.reduce((t, s) => t + s.disponivel, 0));
        const meta = arred(saldos.reduce((t, s) => t + (s.eventual ? 0 : s.meta), 0));
        linhas.push(saldos.length
          ? `${rotulos[cat] || cat}: ${disp >= 0 ? `ainda pode gastar ${moeda(disp)}` : `passou ${moeda(-disp)} do planejado`} em ${MESES[Number(mesAtual.slice(5)) - 1]}.`
            + (saldos.length > 1 ? '\n' + saldos.map((s) => `• ${frasesSaldo(s)}`).join('\n') : '')
          : `${rotulos[cat] || cat}: nenhum item com meta definida.`);
        detalhes.push({ categoria: cat, disponivel: disp, meta_mensal: meta });
      }
      for (const g of alvosItens.filter((g) => !alvosCats.includes(g.categoria))) {
        const s = saldoItem(usuarioId, g, mesAtual);
        linhas.push(frasesSaldo(s, s.eventual ? '' : ` em ${MESES[Number(mesAtual.slice(5)) - 1]}`));
        detalhes.push({ item_id: g.id, meta: s.meta, realizado: s.realizado, disponivel: s.disponivel });
      }
      return { acao: 'consulta', resposta: '💰 ' + linhas.join('\n\n'), detalhes };
    }

    if (c.tipo === 'total_gasto') {
      const de = /^\d{4}-\d{2}$/.test(c.mes_de) ? c.mes_de : mesAtual;
      const ate = /^\d{4}-\d{2}$/.test(c.mes_ate) && c.mes_ate >= de ? c.mes_ate : de;
      const periodo = de === ate ? nomeMes(de) : `${nomeMes(de)} a ${nomeMes(ate)}`;
      const total = (ids) => {
        if (!ids.length) return 0;
        return arred(db.prepare(`SELECT COALESCE(SUM(valor), 0) AS t FROM lancamentos_gastos WHERE usuario_id = ? AND substr(data, 1, 7) BETWEEN ? AND ?
          AND gasto_id IN (${ids.map(() => '?').join(',')})`).get(usuarioId, de, ate, ...ids).t);
      };
      if (!alvosItens.length && !alvosCats.length) {
        if (termo) return { acao: 'consulta_sem_alvo', resposta: `Não encontrei "${termo}" no seu orçamento. Tente o nome de um item ou de uma categoria.` };
        const t = total(itens.map((g) => g.id));
        return { acao: 'consulta', resposta: `📊 Em ${periodo} os gastos somam ${moeda(t)}.`, detalhes: [{ total: t, de, ate }] };
      }
      const linhas = [];
      const detalhes = [];
      for (const cat of alvosCats) {
        const t = total(itens.filter((g) => g.categoria === cat).map((g) => g.id));
        linhas.push(`${rotulos[cat] || cat}: ${moeda(t)}`);
        detalhes.push({ categoria: cat, total: t });
      }
      for (const g of alvosItens.filter((g) => !alvosCats.includes(g.categoria))) {
        const t = total([g.id]);
        linhas.push(`${g.descricao}: ${moeda(t)}`);
        detalhes.push({ item_id: g.id, total: t });
      }
      return { acao: 'consulta', resposta: `📊 Gastos em ${periodo}:\n` + linhas.join('\n'), detalhes };
    }
    return { acao: 'ajuda', resposta: AJUDA };
  }

  // ── Mensagem recebida (WhatsApp ou simulador) ──
  async function processarMensagem({ usuarioId, pessoa, texto, tipo = 'texto', canal = 'whatsapp' }) {
    const cfg = configAlertas(usuarioId);
    const limpo = String(texto || '').trim();
    if (!limpo) {
      return { acao: tipo === 'audio' ? 'audio_sem_transcricao' : 'vazia', intencao: null,
        resposta: tipo === 'audio' ? 'Não consegui entender o áudio. Pode mandar por texto?' : AJUDA };
    }

    // Atalho sem IA: valor + item já ensinado pelo usuário (Em suspenso → confirmar) e não é pergunta
    if (!PARECE_PERGUNTA.test(limpo)) {
      const r = interpretarMensagem(limpo);
      const { gasto_id, seguro } = identificarItem(usuarioId, r.descricao);
      if (seguro && r.valor) {
        const out = processarLancamentos(usuarioId, pessoa, limpo, [{ descricao: r.descricao, valor: r.valor, data: r.data, item_id: gasto_id, confianca: 'alta', parcelas: 1 }], cfg);
        return { ...out, intencao: 'lancamento', via: 'regras' };
      }
    }

    // Sem IA configurada: o que tiver valor fica em suspenso; perguntas recebem a ajuda
    if (!process.env.ANTHROPIC_API_KEY) {
      const r = interpretarMensagem(limpo);
      if (r.valor && !PARECE_PERGUNTA.test(limpo)) {
        const { gasto_id } = identificarItem(usuarioId, r.descricao);
        const out = processarLancamentos(usuarioId, pessoa, limpo, [{ descricao: r.descricao, valor: r.valor, data: r.data, item_id: gasto_id, confianca: 'baixa', parcelas: 1 }], cfg);
        return { ...out, intencao: 'lancamento', via: 'regras' };
      }
      return { acao: 'ajuda', intencao: 'outro', via: 'regras', resposta: `Ainda não consigo responder perguntas por aqui.\n${AJUDA}` };
    }

    let ia;
    try {
      ia = await interpretarComIA(usuarioId, pessoa, limpo);
    } catch (e) {
      console.error('[whatsapp] falha na IA:', e.message);
      const r = interpretarMensagem(limpo);
      if (r.valor) {
        suspender(usuarioId, pessoa?.id ?? null, limpo, { descricao: r.descricao, valor: r.valor, data: r.data, item_id: null, parcelas: 1 });
        return { acao: 'suspenso', intencao: 'lancamento', via: 'erro_ia', resposta: `⏸️ Recebi "${limpo}", mas não consegui classificar agora. Ficou em suspenso no app.` };
      }
      return { acao: 'erro', intencao: null, via: 'erro_ia', resposta: 'Tive um problema para entender a mensagem agora. Pode tentar de novo em instantes?' };
    }
    const { resultado: r, uso } = ia;
    if (!r) return { acao: 'recusa', intencao: null, via: 'ia', uso, resposta: 'Não consegui ajudar com essa mensagem.' };

    if (r.intencao === 'lancamento' && r.lancamentos?.length) {
      return { ...processarLancamentos(usuarioId, pessoa, limpo, r.lancamentos, cfg), intencao: 'lancamento', via: 'ia', uso };
    }
    if (r.intencao === 'consulta' && r.consulta && r.consulta.tipo !== 'nenhuma') {
      return { ...responderConsulta(usuarioId, r.consulta), intencao: 'consulta', via: 'ia', uso };
    }
    return { acao: 'ajuda', intencao: 'outro', via: 'ia', uso, resposta: r.resposta_livre?.trim() || AJUDA };
  }

  function registrarMensagem(dados, saida) {
    const u = saida.uso || {};
    const r = db.prepare(`INSERT INTO whatsapp_mensagens (usuario_id, pessoa_id, telefone, mensagem_id, canal, tipo, texto, intencao, acao, resposta, detalhes,
      modelo, tokens_entrada, tokens_saida, tokens_cache, custo_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(dados.usuarioId ?? null, dados.pessoa?.id ?? null, cifrar(dados.telefone || ''), dados.mensagemId || null, dados.canal || 'whatsapp', dados.tipo || 'texto',
        String(dados.texto || ''), saida.intencao ?? null, saida.acao, saida.resposta, JSON.stringify(saida.detalhes ?? null),
        u.modelo || null, u.tokens_entrada || 0, u.tokens_saida || 0, u.tokens_cache || 0, u.custo_usd || 0);
    return Number(r.lastInsertRowid);
  }

  // ── Avisos ──
  // Grava um aviso por destinatário (sem repetir a mesma chave). Status 'pendente' = na fila de saída.
  const inserirAviso = db.prepare(`INSERT OR IGNORE INTO avisos (usuario_id, tipo, chave, data_ref, titulo, mensagem, destino, status, pessoa_id, template, variaveis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  function statusInicial(destino) {
    if (!destino) return 'sem_destino';
    return integracaoAtiva() ? 'pendente' : 'sem_canal';
  }
  // A Meta recusa parâmetro de template vazio ou com quebra de linha: as variáveis saem sempre limpas
  const variaveisTemplate = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => {
    const t = String(x ?? '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return [k, t || '—'];
  }));
  function gravarAviso(usuarioId, cfg, a, excetoPessoaId = null) {
    const criados = [];
    const textoMaster = textosPersonalizados()[a.tipo];
    for (const p of destinatariosAlerta(usuarioId, cfg)) {
      if (excetoPessoaId && p.id === excetoPessoaId) continue;
      const vars = { nome: primeiroNome(p.nome), ...(a.variaveis || {}) };
      const mensagem = textoMaster ? preencherTexto(textoMaster, vars) : a.mensagem;
      const r = inserirAviso.run(usuarioId, a.tipo, `${a.chave}:p${p.id}`, a.data_ref, a.titulo, mensagem, cifrar(p.destino), statusInicial(p.destino),
        p.id, TIPOS_ALERTA[a.tipo]?.template || '', JSON.stringify(variaveisTemplate(vars)));
      if (r.changes) criados.push({ id: Number(r.lastInsertRowid), usuario_id: usuarioId, pessoa_id: p.id, ...a });
    }
    return criados;
  }
  function registrarAvisoImediato(usuarioId, cfg, tipo, chave, titulo, mensagem, variaveis, excetoPessoaId) {
    return gravarAviso(usuarioId, cfg, { tipo, chave, data_ref: agoraBrasilia().hoje, titulo, mensagem, variaveis }, excetoPessoaId);
  }

  // Alertas novos do agendador (os de contas e fatura continuam em avisosDoDia, no server.js)
  function avisosConfiguraveis(usuarioId, hoje, hora, cfg) {
    const avisos = [];
    const mes = hoje.slice(0, 7);

    // Meta perto do limite: uma vez por item, mês e percentual
    if (cfg.meta_atingida.ativo && cfg.meta_atingida.parametros.percentuais?.length) {
      for (const g of itensDoUsuario(usuarioId).filter((x) => x.valor > 0 && x.categoria !== CATEGORIA_NI)) {
        const s = saldoItem(usuarioId, g, mes);
        const pct = percentual(s);
        const atingido = cfg.meta_atingida.parametros.percentuais.filter((p) => pct >= p).pop();
        if (!atingido) continue;
        const base = s.eventual ? 'do limite anual' : 'da meta do mês';
        avisos.push({
          tipo: 'meta_atingida', chave: `meta:${g.id}:${mes}:${atingido}`, data_ref: hoje,
          titulo: `${g.descricao}: ${pct}% ${base}`,
          mensagem: !passou(s)
            ? `⚠️ ${g.descricao} já usou ${pct}% ${base} (${moeda(s.realizado)} de ${moeda(s.meta)}).${s.disponivel > 0 ? ` Ainda dá para gastar ${moeda(s.disponivel)}.` : ''}`
            : `🚨 ${g.descricao} passou ${base}: ${moeda(s.realizado)} de ${moeda(s.meta)} (${moeda(-s.disponivel)} acima).`,
          variaveis: { item: g.descricao, percentual: String(pct), realizado: moeda(s.realizado), meta: moeda(s.meta), disponivel: moedaSinal(s.disponivel) },
        });
      }
    }

    // Quanto ainda posso gastar: nos dias e a partir da hora escolhidos
    const lp = cfg.limite_programado;
    const diaSemana = new Date(`${hoje}T12:00:00Z`).getUTCDay();
    if (lp.ativo && lp.parametros.dias_semana.includes(diaSemana) && hora >= lp.parametros.hora) {
      const itens = itensDoUsuario(usuarioId);
      const escolhidos = lp.parametros.itens.length
        ? itens.filter((g) => lp.parametros.itens.includes(g.id))
        : itens.filter((g) => g.categoria === 'alimentacao');
      const saldos = escolhidos.filter((g) => g.valor > 0).map((g) => saldoItem(usuarioId, g, mes));
      if (saldos.length) {
        const [a, m] = mes.split('-').map(Number);
        const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
        const diasRestantes = ultimo - Number(hoje.slice(8)) + 1;
        const total = arred(saldos.reduce((t, s) => t + Math.max(0, s.disponivel), 0));
        const linhas = saldos.map((s) => `• ${frasesSaldo(s)}`).join('\n');
        avisos.push({
          tipo: 'limite_programado', chave: `limite:${hoje}`, data_ref: hoje,
          titulo: 'Quanto ainda dá para gastar',
          mensagem: `💡 Até o fim de ${MESES[m - 1]} ainda dá para gastar ${moeda(total)} nestes itens (cerca de ${moeda(total / diasRestantes)} por dia):\n${linhas}`,
          variaveis: { total: moeda(total), por_dia: moeda(total / diasRestantes), mes: MESES[m - 1], lista: linhas },
        });
      }
    }
    return avisos;
  }

  // ── Rotas da integração (servidor a servidor) ──
  function authIntegracao(req, res, next) {
    const esperado = process.env.WHATSAPP_INTEGRACAO_TOKEN;
    if (!esperado) return res.status(503).json({ erro: 'Integração com o WhatsApp desligada (WHATSAPP_INTEGRACAO_TOKEN não definido).' });
    const recebido = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(recebido), b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ erro: 'Token da integração inválido' });
    next();
  }

  app.get('/integracao/whatsapp/saude', authIntegracao, (req, res) => {
    res.json({ ok: true, ia: !!process.env.ANTHROPIC_API_KEY, modelo: process.env.WHATSAPP_MODELO_IA || MODELO_PADRAO, hora: new Date().toISOString() });
  });

  app.post('/integracao/whatsapp/mensagens', authIntegracao, async (req, res) => {
    const { mensagem_id, telefone, tipo = 'texto', texto = '' } = req.body || {};
    if (!telefone) return res.status(400).json({ erro: 'Informe o telefone de quem enviou' });
    if (!['texto', 'audio'].includes(tipo)) return res.status(400).json({ erro: 'tipo deve ser "texto" ou "audio"' });
    // Mesma mensagem entregue de novo pelo provedor: devolve a resposta já dada, sem lançar outra vez
    if (mensagem_id) {
      const ja = db.prepare('SELECT * FROM whatsapp_mensagens WHERE mensagem_id = ?').get(String(mensagem_id));
      if (ja) return res.json({ id: ja.id, mensagem_id: ja.mensagem_id, acao: ja.acao, intencao: ja.intencao, resposta: ja.resposta, repetida: true });
    }
    // "ZEVEM 123456": confirma que este WhatsApp é da pessoa que gerou o código em Configurações
    const codigo = String(texto).match(/\bzevem\s*(\d{6})\b/i)?.[1];
    if (codigo) {
      const saida = confirmarTelefone(telefone, codigo);
      const id = registrarMensagem({ usuarioId: saida.pessoa?.usuario_id, pessoa: saida.pessoa, telefone, mensagemId: mensagem_id, tipo, texto }, saida);
      return res.json({ id, mensagem_id: mensagem_id || null, acao: saida.acao, resposta: saida.resposta, intencao: null });
    }
    const candidatos = pessoaPorTelefone(telefone);
    const contas = new Set(candidatos.map((p) => p.usuario_id));
    if (contas.size !== 1) {
      const saida = contas.size === 0
        ? { acao: 'numero_desconhecido', resposta: 'Este número não está ligado a uma conta do Zevem. Cadastre-o em Configurações › Pessoas e toque em "Confirmar WhatsApp".' }
        : { acao: 'numero_ambiguo', resposta: 'Este número está ligado a mais de uma conta do Zevem. Fale com o suporte.' };
      const id = registrarMensagem({ telefone, mensagemId: mensagem_id, tipo, texto }, saida);
      return res.json({ id, mensagem_id: mensagem_id || null, ...saida, intencao: null });
    }
    const pessoa = candidatos[0];
    const saida = await processarMensagem({ usuarioId: pessoa.usuario_id, pessoa, texto, tipo });
    const id = registrarMensagem({ usuarioId: pessoa.usuario_id, pessoa, telefone, mensagemId: mensagem_id, tipo, texto }, saida);
    res.json({ id, mensagem_id: mensagem_id || null, acao: saida.acao, intencao: saida.intencao, resposta: saida.resposta, detalhes: saida.detalhes ?? null });
  });

  function confirmarTelefone(telefone, codigo) {
    const chave = indice(chaveTelefone(telefone));
    const pessoa = chave && db.prepare(`SELECT id, usuario_id, nome FROM pessoas WHERE telefone_indice = ? AND telefone_codigo = ?
      AND telefone_codigo_expira > ?`).get(chave, crypto.createHash('sha256').update(codigo).digest('hex'), Date.now());
    if (!pessoa) return { acao: 'codigo_invalido', resposta: 'Código inválido ou expirado. Gere um novo em Configurações › Pessoas, no Zevem.' };
    if (db.prepare('SELECT 1 FROM pessoas WHERE telefone_indice = ? AND telefone_verificado = 1 AND usuario_id <> ?').get(chave, pessoa.usuario_id)) {
      return { acao: 'numero_ambiguo', resposta: 'Este número já está confirmado em outra conta do Zevem. Fale com o suporte.' };
    }
    db.prepare('UPDATE pessoas SET telefone_verificado = 1, telefone_codigo = NULL, telefone_codigo_expira = NULL WHERE id = ?').run(pessoa.id);
    return { pessoa, acao: 'telefone_confirmado', resposta: `Pronto, ${pessoa.nome.split(' ')[0]}! Seu WhatsApp está ligado ao Zevem.` };
  }

  // Fila de saída: entrega os avisos pendentes e os reserva por 10 min (se não houver confirmação, voltam)
  app.get('/integracao/whatsapp/saida', authIntegracao, (req, res) => {
    const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 50));
    const lote = db.transaction(() => {
      // Aviso que ficou mais de 24h sem ser enviado perdeu o sentido (ex.: "vence hoje"): não vai mais
      db.prepare(`UPDATE avisos SET status = 'expirado' WHERE status IN ('pendente', 'reservado') AND criado_em < datetime('now', '-24 hours')`).run();
      const ids = db.prepare(`SELECT id FROM avisos WHERE status = 'pendente'
        OR (status = 'reservado' AND reservado_em < datetime('now', '-10 minutes')) ORDER BY criado_em, id LIMIT ?`).all(limite).map((r) => r.id);
      if (!ids.length) return [];
      db.prepare(`UPDATE avisos SET status = 'reservado', reservado_em = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      return db.prepare(`SELECT id, usuario_id, pessoa_id, tipo, destino AS telefone, titulo, mensagem, template, variaveis, data_ref, criado_em
        FROM avisos WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY criado_em, id`).all(...ids);
    })();
    res.json(lote.map((a) => ({ ...a, telefone: decifrar(a.telefone), variaveis: lerJson(a.variaveis, {}) })));
  });

  app.post('/integracao/whatsapp/saida/:id/status', authIntegracao, (req, res) => {
    const { status, erro, mensagem_id_provedor } = req.body || {};
    if (!['enviado', 'falhou'].includes(status)) return res.status(400).json({ erro: 'status deve ser "enviado" ou "falhou"' });
    const r = db.prepare(`UPDATE avisos SET status = ?, erro = ?, mensagem_id_provedor = ?, enviado_em = CASE WHEN ? = 'enviado' THEN CURRENT_TIMESTAMP END
      WHERE id = ? AND status IN ('reservado', 'pendente', 'falhou')`).run(status, erro || null, mensagem_id_provedor || null, status, req.params.id);
    if (!r.changes) return res.status(404).json({ erro: 'Aviso não encontrado ou já confirmado' });
    res.json({ ok: true });
  });

  // ── Rotas do app ──
  app.get('/alertas/config', auth(), (req, res) => {
    const cfg = configAlertas(req.user.id);
    const pessoas = db.prepare('SELECT id, nome, telefone, telefone_verificado FROM pessoas WHERE usuario_id = ? ORDER BY id').all(req.user.id)
      .map((p) => ({ ...p, telefone: decifrar(p.telefone) }));
    res.json({
      integracao_ativa: integracaoAtiva(),
      ia_ativa: !!process.env.ANTHROPIC_API_KEY,
      pessoas: pessoas.map((p) => ({ id: p.id, nome: p.nome, telefone: p.telefone || '', tem_telefone: !!chaveTelefone(p.telefone) && !!p.telefone_verificado,
        telefone_pendente: !!chaveTelefone(p.telefone) && !p.telefone_verificado })),
      tipos: Object.entries(TIPOS_ALERTA).map(([tipo, d]) => ({ tipo, titulo: d.titulo, descricao: d.descricao, template: d.template, ...cfg[tipo] })),
      // Para escolher os itens do alerta "Quanto ainda posso gastar"
      itens: (() => {
        const rot = rotulosCategorias(req.user.id);
        return itensDoUsuario(req.user.id).filter((g) => g.categoria !== CATEGORIA_NI)
          .map((g) => ({ id: g.id, descricao: g.descricao, categoria: g.categoria, categoria_nome: rot[g.categoria] || g.categoria, meta: g.valor }));
      })(),
    });
  });

  app.put('/alertas/config/:tipo', auth(), (req, res) => {
    const tipo = req.params.tipo;
    if (!TIPOS_ALERTA[tipo]) return res.status(404).json({ erro: 'Tipo de alerta desconhecido' });
    const v = validarConfig(tipo, req.body || {});
    db.prepare(`INSERT INTO alertas_config (usuario_id, tipo, ativo, parametros, destinatarios, atualizado_em) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(usuario_id, tipo) DO UPDATE SET ativo = excluded.ativo, parametros = excluded.parametros, destinatarios = excluded.destinatarios, atualizado_em = CURRENT_TIMESTAMP`)
      .run(req.user.id, tipo, v.ativo ? 1 : 0, JSON.stringify(v.parametros), JSON.stringify(v.destinatarios));
    res.json({ tipo, ...configAlertas(req.user.id)[tipo] });
  });

  // Simulador: processa como se a mensagem tivesse chegado pelo WhatsApp da pessoa escolhida (lança de verdade)
  app.post('/whatsapp/simular', auth(), iaLimiter, async (req, res) => {
    const texto = String(req.body?.texto || '').trim();
    if (!texto) return res.status(400).json({ erro: 'Mensagem vazia' });
    const pessoa = req.body?.pessoa_id
      ? db.prepare('SELECT id, usuario_id, nome, telefone FROM pessoas WHERE id = ? AND usuario_id = ?').get(req.body.pessoa_id, req.user.id)
      : db.prepare('SELECT id, usuario_id, nome, telefone FROM pessoas WHERE usuario_id = ? ORDER BY id LIMIT 1').get(req.user.id);
    if (pessoa) pessoa.telefone = decifrar(pessoa.telefone);
    const saida = await processarMensagem({ usuarioId: req.user.id, pessoa, texto, canal: 'simulador' });
    const id = registrarMensagem({ usuarioId: req.user.id, pessoa, telefone: pessoa?.telefone || '', tipo: 'texto', texto, canal: 'simulador' }, saida);
    res.json({ id, acao: saida.acao, intencao: saida.intencao, resposta: saida.resposta, detalhes: saida.detalhes ?? null, via: saida.via, uso: saida.uso ?? null });
  });

  app.get('/whatsapp/mensagens', auth(), (req, res) => {
    const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 50));
    res.json(db.prepare(`SELECT m.id, m.pessoa_id, p.nome AS pessoa, m.canal, m.tipo, m.texto, m.intencao, m.acao, m.resposta, m.custo_usd, m.criado_em
      FROM whatsapp_mensagens m LEFT JOIN pessoas p ON p.id = m.pessoa_id WHERE m.usuario_id = ? ORDER BY m.criado_em DESC, m.id DESC LIMIT ?`).all(req.user.id, limite));
  });

  return { configAlertas, gravarAviso, avisosConfiguraveis, chaveTelefone, pessoaPorTelefone, statusInicial };
};

module.exports.TIPOS_ALERTA = TIPOS_ALERTA;
module.exports.chaveTelefone = chaveTelefone;
module.exports.TEXTOS_ALERTA = TEXTOS_ALERTA;
module.exports.preencherTexto = preencherTexto;
