// Cálculo do M.I.M. (investimento mensal) de um sonho. Usado na grade de Sonhos e na
// Gestão de Pagamentos (linha "Meta de Investimento Mensal" = soma dos M.I.M.).

export interface SonhoCalculo {
  valor_total: number | null;
  prazo: number;
  rentabilidade: number;
  valor_inicial: number | null;
  data_inicio: string;
  valor_selado: number | null;
}

// Aceita "dd/mm/aaaa" ou "aaaa-mm-dd".
export function parseDataSonho(str: string): Date | null {
  if (!str || str.length < 8) return null;
  const parts = str.includes('/') ? str.split('/') : str.split('-');
  if (parts.length !== 3) return null;
  const [a, b, c] = parts;
  if (str.includes('-')) return new Date(+a, +b - 1, +c);
  return new Date(+c, +b - 1, +a);
}

export function mesesRestantesSonho(s: SonhoCalculo, hoje = new Date()): number | null {
  const d = parseDataSonho(s.data_inicio);
  if (!d || !s.prazo) return null;
  const fim = new Date(d);
  fim.setMonth(fim.getMonth() + (s.prazo || 0));
  const diff = (fim.getFullYear() - hoje.getFullYear()) * 12 + (fim.getMonth() - hoje.getMonth());
  return Math.max(0, diff);
}

export function mimSonho(s: SonhoCalculo, hoje = new Date()): number | null {
  if (!s.valor_total) return null;
  const prazoTotal = s.prazo || 0;
  if (prazoTotal <= 0) return null;
  const r = (s.rentabilidade || 0) / 100;

  // n do FV = meses restantes (de hoje até data fim)
  const nRestantes = mesesRestantesSonho(s, hoje) ?? prazoTotal;

  // valor atual poupado: valor_selado se preenchido, senão valor_inicial
  const valorAtual = (s.valor_selado && s.valor_selado > 0) ? s.valor_selado : (s.valor_inicial || 0);

  // FV do valor atual projetado pelos meses restantes
  const fvAtual = r > 0 ? valorAtual * Math.pow(1 + r, nRestantes) : valorAtual;

  // meta restante = valor total - o que o valor atual vai virar
  const metaRestante = s.valor_total - fvAtual;
  if (metaRestante <= 0) return 0;

  // PMT sobre o prazo TOTAL (como calculado desde o início)
  if (r === 0) return metaRestante / prazoTotal;
  const pmt = metaRestante * r / (Math.pow(1 + r, prazoTotal) - 1);
  return Math.round(pmt);
}
