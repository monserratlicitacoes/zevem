// Templates aprovados na Meta e a ORDEM dos parâmetros do corpo ({{1}}, {{2}}...), conforme a
// documentação da integração. O Zevem manda as variáveis por nome; aqui viram a lista na ordem certa.
// Chaves extras (ex.: `quando`, `lista`) são ignoradas. Mudou o texto aprovado na Meta? Ajuste aqui.
const TEMPLATES = {
  ag_conta_vencendo: ['nome', 'conta', 'vencimento', 'valor'],
  ag_fatura_fecha: ['nome', 'cartao', 'fechamento'],
  ag_melhor_dia_compra: ['nome', 'cartao', 'pagamento'],
  ag_fatura_vence: ['nome', 'cartao', 'vencimento'],
  ag_meta_atingida: ['nome', 'item', 'percentual', 'realizado', 'meta', 'disponivel'],
  ag_limite_programado: ['nome', 'total', 'por_dia', 'mes'],
  ag_lancamento_outra_pessoa: ['nome', 'pessoa', 'valor', 'item', 'saldo'],
};

// A Meta recusa parâmetro vazio ou com quebra de linha
const limpar = (v) => String(v ?? '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim() || '—';

function parametrosTemplate(nome, variaveis = {}) {
  const ordem = TEMPLATES[nome];
  if (!ordem) {
    const e = new Error(`Template desconhecido: ${nome}`);
    e.temporario = false;
    throw e;
  }
  return ordem.map((k) => limpar(variaveis[k]));
}

module.exports = { TEMPLATES, parametrosTemplate };
