// Monta o integrador: HTTP (webhook e saúde), processamento das mensagens e laço da fila.
const http = require('node:http');
const lerConfig = require('./config');
const abrirEstado = require('./estado');
const criarZevem = require('./zevem');
const criarTranscricao = require('./transcricao');
const criarEntrada = require('./entrada');
const criarFila = require('./fila');
const { criarProvedor } = require('./provedores');

const LIMITE_CORPO = 1024 * 1024;

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (p) => {
      tamanho += p.length;
      if (tamanho > LIMITE_CORPO) { reject(Object.assign(new Error('Corpo grande demais'), { status: 413 })); req.destroy(); return; }
      partes.push(p);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

function responder(res, status, corpo) {
  const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  res.writeHead(status, { 'content-type': typeof corpo === 'string' ? 'text/plain; charset=utf-8' : 'application/json' });
  res.end(texto);
}

function iniciar({ env = process.env, log = console, arquivoEstado } = {}) {
  const config = lerConfig(env);
  const estado = abrirEstado(config.dataDir, arquivoEstado);
  const provedor = criarProvedor(config.provedor, config);
  const zevem = criarZevem(config.zevem);
  const transcricao = criarTranscricao(config.transcricao);
  const entrada = criarEntrada({ estado, provedor, zevem, transcricao, log });
  const fila = criarFila({ estado, provedor, zevem, config, log });
  const ativo = provedor.configurado && zevem.configurado;

  const processar = () => entrada.processarPendentes().catch((e) => log.error(`[entrada] ${e.message}`));

  async function webhook(req, res, url) {
    if (!ativo) return responder(res, 503, { erro: 'Integrador desligado: configure o provedor e WHATSAPP_INTEGRACAO_TOKEN' });
    if (req.method === 'GET') {
      const desafio = provedor.desafio(Object.fromEntries(url.searchParams));
      return desafio === null ? responder(res, 403, { erro: 'Verificação recusada' }) : responder(res, 200, desafio);
    }
    if (req.method !== 'POST') return responder(res, 405, { erro: 'Método não permitido' });
    const bruto = await lerCorpo(req);
    if (!provedor.validarRequisicao(req.headers, bruto)) {
      log.warn('[webhook] assinatura inválida');
      return responder(res, 401, { erro: 'Assinatura inválida' });
    }
    let corpo;
    try { corpo = JSON.parse(bruto.toString('utf8') || '{}'); } catch { return responder(res, 400, { erro: 'JSON inválido' }); }
    const { mensagens, status } = provedor.extrairEventos(corpo);
    // Grava antes de responder 200: se o processo cair depois, nada se perde
    entrada.registrar(mensagens);
    for (const s of status) estado.atualizarStatusProvedor(s.provedor_id, s.status, s.erro);
    responder(res, 200, { ok: true });
    if (mensagens.length) setImmediate(processar);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        return responder(res, 200, { status: 'ok', provedor: provedor.nome, ativo, transcricao: transcricao.configurado, entrada: estado.resumo() });
      }
      if (url.pathname === '/webhook') return await webhook(req, res, url);
      if (url.pathname === '/simulado/enviadas' && provedor.nome === 'simulado' && req.method === 'GET') {
        return responder(res, 200, provedor.enviadas);
      }
      responder(res, 404, { erro: 'Não encontrado' });
    } catch (e) {
      log.error(`[http] ${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) responder(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno' });
    }
  });

  // Rotinas: pendentes a cada 5 s (novas tentativas), fila no intervalo configurado, saúde e limpeza
  const timers = [];
  function agendar() {
    if (!ativo) {
      log.warn(`[integrador] desligado: provedor "${provedor.nome}" ${provedor.configurado ? 'ok' : 'sem configuração'}, token do Zevem ${zevem.configurado ? 'ok' : 'ausente'}`);
      return;
    }
    processar(); // retoma o que ficou pendente antes de um reinício
    timers.push(setInterval(processar, 5_000));
    if (config.fila.intervaloMs > 0) timers.push(setInterval(() => fila.rodar(), config.fila.intervaloMs));
    const checarSaude = () => zevem.saude()
      .then((s) => { if (!s.ia) log.warn('[saude] Zevem sem IA configurada (ANTHROPIC_API_KEY)'); })
      .catch((e) => log.error(`[saude] Zevem indisponível: ${e.message}`));
    checarSaude();
    timers.push(setInterval(checarSaude, 5 * 60_000));
    timers.push(setInterval(() => estado.limpar(), 24 * 3_600_000));
    for (const t of timers) t.unref?.();
  }

  return {
    config, estado, provedor, entrada, fila, server,
    ouvir(porta = config.porta) {
      return new Promise((resolve) => server.listen(porta, () => {
        log.info(`[integrador] ouvindo na porta ${server.address().port} (provedor: ${provedor.nome}, transcrição: ${transcricao.configurado ? config.transcricao.provedor : 'desligada'})`);
        agendar();
        resolve(server.address().port);
      }));
    },
    async parar() {
      for (const t of timers) clearInterval(t);
      await new Promise((r) => server.close(r));
      estado.fechar();
    },
  };
}

module.exports = { iniciar };
