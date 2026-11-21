// Testes ponta a ponta do integrador com a Meta (Graph API), o Zevem e a transcrição simulados.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { iniciar } = require('../src/app');
const { parametrosTemplate } = require('../src/templates');
const { chaveTelefone, paraEnvio } = require('../src/telefone');

const silencioso = process.env.DEBUG_TESTE ? console : { info() {}, warn() {}, error() {} };
const SEGREDO = 'segredo-do-app';

// Servidor HTTP falso que registra as chamadas e responde com `responder(req, corpo)`
function servidorFalso(responder) {
  const chamadas = [];
  const server = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', async () => {
      const bruto = Buffer.concat(partes);
      let corpo = null;
      try { corpo = JSON.parse(bruto.toString()); } catch { corpo = bruto; }
      const chamada = { metodo: req.method, caminho: req.url, corpo, headers: req.headers };
      chamadas.push(chamada);
      const r = (await responder(chamada)) || { status: 200, corpo: {} };
      if (Buffer.isBuffer(r.corpo)) { res.writeHead(r.status, { 'content-type': r.tipo || 'application/octet-stream' }); return res.end(r.corpo); }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.corpo));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, chamadas, url: `http://127.0.0.1:${server.address().port}` })));
}

let zevem, meta, transc, app, base, comportamento;

beforeEach(async () => {
  comportamento = {
    mensagem: () => ({ status: 200, corpo: { id: 1, acao: 'lancado', resposta: '✅ Lancei R$ 45 em Almoço' } }),
    saida: () => ({ status: 200, corpo: [] }),
    status: () => ({ status: 200, corpo: { ok: true } }),
    enviar: () => ({ status: 200, corpo: { messages: [{ id: `wamid.out.${crypto.randomUUID()}` }] } }),
  };
  zevem = await servidorFalso((c) => {
    if (c.caminho === '/integracao/whatsapp/mensagens') return comportamento.mensagem(c);
    if (c.caminho.startsWith('/integracao/whatsapp/saida?')) return comportamento.saida(c);
    if (/\/saida\/\d+\/status$/.test(c.caminho)) return comportamento.status(c);
    if (c.caminho === '/integracao/whatsapp/saude') return { status: 200, corpo: { ok: true, ia: true } };
  });
  meta = await servidorFalso((c) => {
    if (c.caminho === '/v24.0/PNID/messages') {
      if (c.corpo.status === 'read') return { status: 200, corpo: { success: true } };
      return comportamento.enviar(c);
    }
    if (c.caminho === '/v24.0/MIDIA1') return { status: 200, corpo: { url: `${meta.url}/download/MIDIA1`, mime_type: 'audio/ogg; codecs=opus' } };
    if (c.caminho === '/download/MIDIA1') return { status: 200, corpo: Buffer.from('OggS-fake'), tipo: 'audio/ogg' };
  });
  transc = await servidorFalso(() => ({ status: 200, corpo: { text: 'mercado 120 reais' } }));
  app = iniciar({
    log: silencioso,
    arquivoEstado: ':memory:',
    env: {
      ZEVEM_URL: zevem.url, WHATSAPP_INTEGRACAO_TOKEN: 'tok', WHATSAPP_PROVEDOR: 'meta',
      META_GRAPH_URL: meta.url, META_TOKEN: 'mt', META_PHONE_NUMBER_ID: 'PNID', META_APP_SECRET: SEGREDO, META_VERIFY_TOKEN: 'verifica',
      TRANSCRICAO_PROVEDOR: 'openai', TRANSCRICAO_URL: transc.url, TRANSCRICAO_CHAVE: 'tk',
      FILA_INTERVALO_MS: '0',
    },
  });
  base = `http://127.0.0.1:${await app.ouvir(0)}`;
});

afterEach(async () => {
  await app.parar();
  for (const s of [zevem, meta, transc]) s.server.close();
});

function eventoMeta(mensagens, statuses) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PNID' }, messages: mensagens, statuses } }] }],
  };
}
async function postarWebhook(corpo, assinatura) {
  const bruto = JSON.stringify(corpo);
  const sig = assinatura ?? 'sha256=' + crypto.createHmac('sha256', SEGREDO).update(bruto).digest('hex');
  return fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: bruto });
}
const msgTexto = (id, texto, from = '5511987654321') => ({ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } });
const envios = () => meta.chamadas.filter((c) => c.caminho === '/v24.0/PNID/messages' && c.corpo.status !== 'read');
const chamadasZevem = (trecho) => zevem.chamadas.filter((c) => c.caminho.includes(trecho));

test('verificação do webhook (desafio da Meta)', async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=123`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '123');
  const ruim = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123`);
  assert.equal(ruim.status, 403);
});

test('recusa webhook com assinatura inválida', async () => {
  const r = await postarWebhook(eventoMeta([msgTexto('wamid.1', 'almoço 45')]), 'sha256=00');
  assert.equal(r.status, 401);
  await app.entrada.processarPendentes();
  assert.equal(chamadasZevem('/mensagens').length, 0);
});

test('texto: repassa ao Zevem e responde ao usuário uma única vez, mesmo com o webhook repetido', async () => {
  const ev = eventoMeta([msgTexto('wamid.1', 'almoço 45')]);
  assert.equal((await postarWebhook(ev)).status, 200);
  await app.entrada.processarPendentes();
  await postarWebhook(ev); // a Meta reentrega
  await app.entrada.processarPendentes();

  const chamadas = chamadasZevem('/mensagens');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].headers.authorization, 'Bearer tok');
  assert.deepEqual({ ...chamadas[0].corpo, recebida_em: undefined }, { mensagem_id: 'wamid.1', telefone: '5511987654321', tipo: 'texto', texto: 'almoço 45', recebida_em: undefined });
  assert.equal(envios().length, 1);
  assert.deepEqual(envios()[0].corpo.text, { body: '✅ Lancei R$ 45 em Almoço', preview_url: false });
  assert.equal(envios()[0].corpo.to, '5511987654321');
  assert.equal(app.estado.entrada('wamid.1').estado, 'respondida');
  // marcou como lida
  assert.ok(meta.chamadas.some((c) => c.corpo?.status === 'read' && c.corpo.message_id === 'wamid.1'));
});

test('Zevem fora do ar: tenta de novo com a mesma mensagem_id', async () => {
  let n = 0;
  comportamento.mensagem = () => (++n === 1 ? { status: 502, corpo: { erro: 'gateway' } } : { status: 200, corpo: { acao: 'lancado', resposta: 'ok' } });
  await postarWebhook(eventoMeta([msgTexto('wamid.2', 'uber 20')]));
  await app.entrada.processarPendentes();
  let e = app.estado.entrada('wamid.2');
  assert.equal(e.estado, 'recebida');
  assert.equal(e.tentativas, 1);
  app.estado.db.prepare('UPDATE entrada SET proximo_em = 0').run(); // adianta o relógio
  await app.entrada.processarPendentes();
  e = app.estado.entrada('wamid.2');
  assert.equal(e.estado, 'respondida');
  assert.deepEqual(chamadasZevem('/mensagens').map((c) => c.corpo.mensagem_id), ['wamid.2', 'wamid.2']);
  assert.equal(envios().length, 1);
});

test('Zevem ainda processando a mesma mensagem (409): tenta de novo', async () => {
  let n = 0;
  comportamento.mensagem = () => (++n === 1 ? { status: 409, corpo: { erro: 'em processamento' } } : { status: 200, corpo: { acao: 'lancado', resposta: 'ok', repetida: true } });
  await postarWebhook(eventoMeta([msgTexto('wamid.409', 'uber 20')]));
  await app.entrada.processarPendentes();
  assert.equal(app.estado.entrada('wamid.409').estado, 'recebida');
  app.estado.db.prepare('UPDATE entrada SET proximo_em = 0').run();
  await app.entrada.processarPendentes();
  assert.equal(app.estado.entrada('wamid.409').estado, 'respondida');
  assert.equal(envios().length, 1);
});

test('falha ao enviar a resposta: reenvia a resposta guardada sem chamar o Zevem de novo', async () => {
  let n = 0;
  comportamento.enviar = () => (++n === 1 ? { status: 500, corpo: { error: { code: 131000 } } } : { status: 200, corpo: { messages: [{ id: 'wamid.r' }] } });
  await postarWebhook(eventoMeta([msgTexto('wamid.3', 'pizza 60')]));
  await app.entrada.processarPendentes();
  assert.equal(app.estado.entrada('wamid.3').estado, 'processada');
  app.estado.db.prepare('UPDATE entrada SET proximo_em = 0').run();
  await app.entrada.processarPendentes();
  assert.equal(app.estado.entrada('wamid.3').estado, 'respondida');
  assert.equal(chamadasZevem('/mensagens').length, 1);
});

test('áudio: baixa a mídia, transcreve e envia como tipo audio', async () => {
  await postarWebhook(eventoMeta([{ id: 'wamid.4', from: '5511987654321', timestamp: '1700000000', type: 'audio', audio: { id: 'MIDIA1', voice: true } }]));
  await app.entrada.processarPendentes();
  const [c] = chamadasZevem('/mensagens');
  assert.equal(c.corpo.tipo, 'audio');
  assert.equal(c.corpo.texto, 'mercado 120 reais');
  assert.equal(transc.chamadas[0].headers.authorization, 'Bearer tk');
  assert.equal(app.estado.entrada('wamid.4').estado, 'respondida');
});

test('imagem e outros tipos: resposta padrão sem chamar o Zevem; reação é ignorada', async () => {
  await postarWebhook(eventoMeta([
    { id: 'wamid.5', from: '5511987654321', timestamp: '1700000000', type: 'image', image: { id: 'X' } },
    { id: 'wamid.6', from: '5511987654321', timestamp: '1700000000', type: 'reaction', reaction: { emoji: '👍' } },
  ]));
  await app.entrada.processarPendentes();
  assert.equal(chamadasZevem('/mensagens').length, 0);
  assert.equal(envios().length, 1);
  assert.equal(envios()[0].corpo.text.body, app.entrada.RESPOSTA_NAO_SUPORTADA);
  assert.equal(app.estado.entrada('wamid.6'), undefined);
});

test('status de entrega da Meta atualiza o envio do aviso', async () => {
  app.estado.registrarEnvio({ aviso_id: 9, destino: 'x', forma: 'template', provedor_id: 'wamid.out.9', status: 'enviado' });
  await postarWebhook(eventoMeta(undefined, [{ id: 'wamid.out.9', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }]));
  const e = app.estado.db.prepare('SELECT * FROM envios WHERE provedor_id = ?').get('wamid.out.9');
  assert.equal(e.status, 'falhou_entrega');
  assert.match(e.erro, /131026/);
});

const aviso = (id, extra = {}) => ({
  id, usuario_id: 1, pessoa_id: 1, tipo: 'fatura_vence', telefone: '11987654321', titulo: 't',
  mensagem: '💳 A fatura do Nubank vence amanhã', template: 'ag_fatura_vence',
  variaveis: { nome: 'Maria', cartao: 'Nubank', vencimento: '10/12', quando: 'amanhã' }, ...extra,
});

test('fila: fora da janela de 24h envia template com os parâmetros na ordem e confirma', async () => {
  comportamento.saida = () => ({ status: 200, corpo: [aviso(7)] });
  comportamento.enviar = () => ({ status: 200, corpo: { messages: [{ id: 'wamid.t7' }] } });
  assert.equal(await app.fila.rodar(), 1);
  const [e] = envios();
  assert.equal(e.corpo.to, '5511987654321');
  assert.equal(e.corpo.type, 'template');
  assert.equal(e.corpo.template.name, 'ag_fatura_vence');
  assert.equal(e.corpo.template.language.code, 'pt_BR');
  assert.deepEqual(e.corpo.template.components[0].parameters.map((p) => p.text), ['Maria', 'Nubank', '10/12']);
  const [st] = chamadasZevem('/saida/7/status');
  assert.deepEqual(st.corpo, { status: 'enviado', mensagem_id_provedor: 'wamid.t7' });
});

test('fila: dentro da janela envia texto livre para o número exato que escreveu (sem o nono dígito)', async () => {
  await postarWebhook(eventoMeta([msgTexto('wamid.8', 'oi', '551187654321')]));
  await app.entrada.processarPendentes();
  comportamento.saida = () => ({ status: 200, corpo: [aviso(8)] });
  await app.fila.rodar();
  const e = envios().at(-1);
  assert.equal(e.corpo.type, 'text');
  assert.equal(e.corpo.to, '551187654321');
  assert.equal(e.corpo.text.body, '💳 A fatura do Nubank vence amanhã');
});

test('fila: janela fechada no texto cai para o template', async () => {
  app.estado.salvarContato(chaveTelefone('11987654321'), '5511987654321', Date.now());
  let n = 0;
  comportamento.enviar = () => (++n === 1
    ? { status: 400, corpo: { error: { code: 131047, message: 'Re-engagement message' } } }
    : { status: 200, corpo: { messages: [{ id: 'wamid.t10' }] } });
  comportamento.saida = () => ({ status: 200, corpo: [aviso(10)] });
  await app.fila.rodar();
  assert.deepEqual(envios().map((e) => e.corpo.type), ['text', 'template']);
  assert.equal(chamadasZevem('/saida/10/status')[0].corpo.status, 'enviado');
});

test('fila: erro definitivo confirma falhou; erro temporário deixa o aviso voltar', async () => {
  comportamento.enviar = () => ({ status: 400, corpo: { error: { code: 131026, message: 'Undeliverable' } } });
  comportamento.saida = () => ({ status: 200, corpo: [aviso(11)] });
  await app.fila.rodar();
  assert.equal(chamadasZevem('/saida/11/status')[0].corpo.status, 'falhou');

  comportamento.enviar = () => ({ status: 503, corpo: { error: { code: 131000 } } });
  comportamento.saida = () => ({ status: 200, corpo: [aviso(12)] });
  await app.fila.rodar();
  assert.equal(chamadasZevem('/saida/12/status').length, 0);
  await app.fila.rodar();
  await app.fila.rodar(); // terceira falha: desiste
  assert.equal(chamadasZevem('/saida/12/status')[0].corpo.status, 'falhou');
});

test('fila: se a confirmação se perdeu, não manda o aviso de novo', async () => {
  let n = 0;
  comportamento.status = () => (++n === 1 ? { status: 502, corpo: {} } : { status: 200, corpo: { ok: true } });
  comportamento.saida = () => ({ status: 200, corpo: [aviso(13)] });
  await app.fila.rodar();
  await app.fila.rodar(); // o Zevem entrega o mesmo aviso depois da reserva
  assert.equal(envios().length, 1);
  assert.equal(chamadasZevem('/saida/13/status').length, 2);
});

test('templates e telefones', () => {
  assert.deepEqual(parametrosTemplate('ag_meta_atingida', { nome: 'Ana', item: 'Mercado', percentual: '80', realizado: 'R$ 800', meta: 'R$ 1.000', disponivel: '' }),
    ['Ana', 'Mercado', '80', 'R$ 800', 'R$ 1.000', '—']);
  assert.throws(() => parametrosTemplate('nao_existe', {}), /Template desconhecido/);
  assert.equal(paraEnvio('(11) 98765-4321'), '5511987654321');
  assert.equal(paraEnvio('123'), '');
  assert.equal(chaveTelefone('5511987654321'), chaveTelefone('551187654321'));
});
