// Configuração do integrador, lida das variáveis de ambiente (ver integrador/.env.example).
const numero = (v, padrao) => (v === undefined || v === '' ? padrao : Number(v));

module.exports = function lerConfig(env = process.env) {
  return {
    porta: numero(env.PORT, 3300),
    dataDir: env.DATA_DIR || '.',
    zevem: {
      url: (env.ZEVEM_URL || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
      token: env.WHATSAPP_INTEGRACAO_TOKEN || '',
      timeoutMs: numero(env.ZEVEM_TIMEOUT_MS, 30_000),
    },
    // Qual adaptador fala com o WhatsApp. Trocar de provedor = trocar esta variável (ver src/provedores).
    provedor: (env.WHATSAPP_PROVEDOR || 'meta').trim().toLowerCase(),
    meta: {
      graphUrl: (env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
      versao: env.META_GRAPH_VERSAO || 'v24.0',
      token: env.META_TOKEN || '',
      phoneNumberId: env.META_PHONE_NUMBER_ID || '',
      appSecret: env.META_APP_SECRET || '',
      verifyToken: env.META_VERIFY_TOKEN || '',
      timeoutMs: numero(env.META_TIMEOUT_MS, 15_000),
    },
    transcricao: {
      // "openai" fala com qualquer API compatível com /audio/transcriptions (OpenAI, Groq...). "nenhuma" desliga.
      provedor: (env.TRANSCRICAO_PROVEDOR || 'nenhuma').trim().toLowerCase(),
      url: (env.TRANSCRICAO_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      chave: env.TRANSCRICAO_CHAVE || '',
      modelo: env.TRANSCRICAO_MODELO || 'whisper-1',
      timeoutMs: numero(env.TRANSCRICAO_TIMEOUT_MS, 60_000),
    },
    fila: {
      intervaloMs: numero(env.FILA_INTERVALO_MS, 60_000),
      limite: numero(env.FILA_LIMITE, 50),
    },
    // Dentro da janela de 24h da última mensagem do usuário, o aviso sai como texto livre (sem custo de template)
    janelaTextoLivre: env.JANELA_TEXTO_LIVRE !== '0',
    idiomaTemplates: env.IDIOMA_TEMPLATES || 'pt_BR',
  };
};
