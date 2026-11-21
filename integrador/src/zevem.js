// Cliente das rotas /integracao/whatsapp/* do backend do Zevem (contrato da documentação da integração).
module.exports = function criarZevem({ url, token, timeoutMs }) {
  async function chamar(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(url + caminho, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const erro = new Error(`Zevem ${metodo} ${caminho}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
      erro.temporario = true;
      throw erro;
    }
    const texto = await r.text();
    let dados;
    try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = { erro: texto.slice(0, 200) }; }
    if (!r.ok) {
      const erro = new Error(`Zevem ${metodo} ${caminho}: ${r.status} ${dados?.erro || ''}`.trim());
      erro.status = r.status;
      // 5xx, 429 e 503 (integração desligada) podem passar; 4xx de validação não
      erro.temporario = r.status >= 500 || r.status === 429;
      throw erro;
    }
    return dados;
  }

  return {
    configurado: !!token,
    saude: () => chamar('GET', '/integracao/whatsapp/saude'),
    // Repetir com a mesma mensagem_id é seguro: o Zevem devolve a resposta já dada (repetida: true)
    mensagem: (dados) => chamar('POST', '/integracao/whatsapp/mensagens', dados),
    saida: (limite) => chamar('GET', `/integracao/whatsapp/saida?limite=${limite}`),
    status: (id, dados) => chamar('POST', `/integracao/whatsapp/saida/${encodeURIComponent(id)}/status`, dados),
  };
};
