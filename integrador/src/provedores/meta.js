// Provedor: WhatsApp Cloud API oficial da Meta (Graph API).
// Variáveis: META_TOKEN (token permanente de usuário do sistema), META_PHONE_NUMBER_ID, META_APP_SECRET
// (assinatura do webhook), META_VERIFY_TOKEN (desafio do webhook), META_GRAPH_VERSAO.
const crypto = require('node:crypto');

// Erros da Meta que significam "fora da janela de 24h: só template" (re-engagement)
const JANELA_FECHADA = new Set([131047]);
// Erros que não adianta repetir: número sem WhatsApp, parâmetro/template inválido, bloqueio do usuário...
const PERMANENTES = new Set([131026, 131008, 131009, 131021, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 131051, 100]);

const STATUS = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falhou_entrega' };

module.exports = function criarMeta(config) {
  const cfg = config.meta;
  const base = `${cfg.graphUrl}/${cfg.versao}`;
  const configurado = !!(cfg.token && cfg.phoneNumberId && cfg.appSecret && cfg.verifyToken);

  async function graph(caminho, { metodo = 'GET', corpo, url, binario = false } = {}) {
    let r;
    try {
      r = await fetch(url || `${base}/${caminho}`, {
        method: metodo,
        headers: { authorization: `Bearer ${cfg.token}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      const erro = new Error(`Meta: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
      erro.temporario = true;
      throw erro;
    }
    if (r.ok && binario) return { dados: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || '' };
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = dados.error || {};
      const erro = new Error(`Meta ${r.status}: ${e.code ?? ''} ${e.error_data?.details || e.message || ''}`.trim());
      erro.status = r.status;
      erro.codigo = e.code;
      erro.janelaFechada = JANELA_FECHADA.has(e.code);
      erro.temporario = !erro.janelaFechada && !PERMANENTES.has(e.code) && (r.status >= 500 || r.status === 429 || e.code === 130429 || e.code === 131000);
      throw erro;
    }
    return dados;
  }

  async function enviar(destino, conteudo) {
    const r = await graph(`${cfg.phoneNumberId}/messages`, {
      metodo: 'POST',
      corpo: { messaging_product: 'whatsapp', recipient_type: 'individual', to: destino, ...conteudo },
    });
    return { id: r.messages?.[0]?.id || null };
  }

  function textoDaMensagem(m) {
    switch (m.type) {
      case 'text': return { tipo: 'texto', texto: m.text?.body || '' };
      case 'audio': return { tipo: 'audio', midia_id: m.audio?.id };
      case 'button': return { tipo: 'texto', texto: m.button?.text || '' };
      case 'interactive': return { tipo: 'texto', texto: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '' };
      // Não pedem resposta
      case 'reaction': case 'system': case 'unsupported': case 'request_welcome': case 'ephemeral': return null;
      default: return { tipo: 'outro' }; // imagem, documento, figurinha, localização, contato, vídeo...
    }
  }

  return {
    nome: 'meta',
    configurado,
    suportaTemplates: true,

    desafio(query) {
      if (query['hub.mode'] === 'subscribe' && cfg.verifyToken && query['hub.verify_token'] === cfg.verifyToken) return String(query['hub.challenge'] ?? '');
      return null;
    },

    validarRequisicao(headers, corpoBruto) {
      const recebida = String(headers['x-hub-signature-256'] || '');
      if (!cfg.appSecret || !recebida.startsWith('sha256=')) return false;
      const esperada = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(corpoBruto).digest('hex');
      const a = Buffer.from(recebida), b = Buffer.from(esperada);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    extrairEventos(corpo) {
      const mensagens = [], status = [];
      if (corpo?.object !== 'whatsapp_business_account') return { mensagens, status };
      for (const entry of corpo.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};
          // Só eventos do nosso número (a mesma app pode ter outros)
          if (cfg.phoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== cfg.phoneNumberId) continue;
          for (const m of v.messages || []) {
            const conteudo = textoDaMensagem(m);
            if (!conteudo || !m.id || !m.from) continue;
            mensagens.push({
              id: m.id, telefone: m.from, destino: m.from, tipo_original: m.type,
              recebida_em: new Date(Number(m.timestamp || 0) * 1000 || Date.now()).toISOString(),
              texto: '', midia_id: null, ...conteudo,
            });
          }
          for (const s of v.statuses || []) {
            if (!s.id || !STATUS[s.status]) continue;
            const e = s.errors?.[0];
            status.push({ provedor_id: s.id, status: STATUS[s.status], erro: e ? `${e.code} ${e.error_data?.details || e.title || ''}`.trim() : null });
          }
        }
      }
      return { mensagens, status };
    },

    async baixarMidia(midiaId) {
      const info = await graph(encodeURIComponent(midiaId));
      if (!info.url) throw Object.assign(new Error('Meta: mídia sem URL'), { temporario: false });
      const { dados, mime } = await graph(null, { url: info.url, binario: true });
      return { dados, mime: info.mime_type || mime };
    },

    enviarTexto: (destino, texto) => enviar(destino, { type: 'text', text: { body: texto, preview_url: false } }),

    enviarTemplate: (destino, nome, idioma, parametros) => enviar(destino, {
      type: 'template',
      template: {
        name: nome,
        language: { code: idioma },
        components: parametros.length ? [{ type: 'body', parameters: parametros.map((text) => ({ type: 'text', text })) }] : [],
      },
    }),

    async marcarLida(mensagemId) {
      await graph(`${cfg.phoneNumberId}/messages`, { metodo: 'POST', corpo: { messaging_product: 'whatsapp', status: 'read', message_id: mensagemId } });
    },
  };
};
