// Transcrição de áudio em pt-BR. "openai" usa o formato /audio/transcriptions, que também é aceito por
// outros fornecedores compatíveis (ex.: Groq: TRANSCRICAO_URL=https://api.groq.com/openai/v1,
// TRANSCRICAO_MODELO=whisper-large-v3-turbo). "nenhuma": áudio segue vazio e o Zevem pede texto.
const EXTENSOES = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/webm': 'webm', 'audio/wav': 'wav' };

module.exports = function criarTranscricao(cfg) {
  if (cfg.provedor === 'nenhuma' || !cfg.provedor) {
    return { configurado: false, async transcrever() { return ''; } };
  }
  if (cfg.provedor !== 'openai') throw new Error(`TRANSCRICAO_PROVEDOR desconhecido: "${cfg.provedor}". Opções: openai, nenhuma`);

  return {
    configurado: !!cfg.chave,
    async transcrever(dados, mime = 'audio/ogg') {
      if (!cfg.chave) return '';
      const tipo = String(mime).split(';')[0].trim() || 'audio/ogg';
      const form = new FormData();
      form.append('file', new Blob([dados], { type: tipo }), `audio.${EXTENSOES[tipo] || 'ogg'}`);
      form.append('model', cfg.modelo);
      form.append('language', 'pt');
      form.append('response_format', 'json');
      let r;
      try {
        r = await fetch(`${cfg.url}/audio/transcriptions`, {
          method: 'POST', headers: { authorization: `Bearer ${cfg.chave}` }, body: form, signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        throw Object.assign(new Error(`Transcrição: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`), { temporario: true });
      }
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw Object.assign(new Error(`Transcrição ${r.status}: ${corpo.error?.message || ''}`.trim()), { temporario: r.status >= 500 || r.status === 429 });
      }
      return String(corpo.text || '').trim();
    },
  };
};
