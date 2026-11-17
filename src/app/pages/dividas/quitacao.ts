// Contas da aba "Quitação Antecipada" do Simulador Financeiro (sistema Price).
// Funções puras, sem Angular, para poderem ser conferidas com um script node.
//
// Notação: P = parcela atual (PMT), i = taxa mensal (0,01 = 1% a.m.), n = parcelas restantes, A = aporte.
// Saldo devedor atual (valor presente das parcelas restantes): S = P · (1 − (1+i)^−n) / i
// "Juros a pagar" = tudo o que ainda sai do bolso daqui em diante − saldo devedor atual.
//   Antes do aporte: P·n − S.  Economia = juros a pagar antes − juros a pagar depois.

export type ModoQuitacao = 'ultimas' | 'proximas' | 'reduzir_parcela' | 'reduzir_prazo' | 'total';

export const MODOS_QUITACAO: { id: ModoQuitacao; label: string }[] = [
  { id: 'ultimas',         label: 'Antecipar parcelas (pagando as últimas)' },
  { id: 'proximas',        label: 'Pagar as próximas parcelas' },
  { id: 'reduzir_parcela', label: 'Amortizar o saldo reduzindo a parcela' },
  { id: 'reduzir_prazo',   label: 'Amortizar o saldo reduzindo o prazo' },
  { id: 'total',           label: 'Quitação total' },
];

export interface CenarioQuitacao {
  modo: ModoQuitacao;
  label: string;
  aplicavel: boolean;
  motivo?: string;            // por que a modalidade não se aplica a este aporte
  aporteUsado: number;        // quanto do aporte entra na dívida
  sobra: number;              // parte do aporte que não é usada (troco)
  falta: number;              // quitação total: quanto falta para quitar
  saldoAntes: number;
  saldoDepois: number;        // a valor presente, hoje
  parcelaAntes: number;
  parcelaDepois: number;
  ultimaParcelaDepois: number | null;  // reduzir prazo: última parcela menor
  prazoAntes: number;
  prazoDepois: number;
  jurosAntes: number;
  jurosDepois: number;
  economia: number;
  parcelasQuitadas: number;   // últimas: parcelas que somem; próximas: parcelas pagas
  jurosEmbutidos: number;     // próximas: juros que vão dentro do valor cheio das parcelas pagas
}

/** Valor presente de k parcelas P à taxa i (fator a(k) do Price). */
export function valorPresente(P: number, i: number, k: number): number {
  return k <= 0 ? 0 : P * (1 - Math.pow(1 + i, -k)) / i;
}

/** Parcela Price de um saldo S em n meses à taxa i. */
export function parcelaPrice(S: number, i: number, n: number): number {
  return S * i / (1 - Math.pow(1 + i, -n));
}

const EPS = 1e-6;

export function simularQuitacao(P: number, i: number, n: number, A: number): CenarioQuitacao[] {
  const S = valorPresente(P, i, n);
  const jurosAntes = P * n - S;
  const base = (modo: ModoQuitacao): CenarioQuitacao => ({
    modo, label: MODOS_QUITACAO.find(m => m.id === modo)!.label,
    aplicavel: true, aporteUsado: 0, sobra: A, falta: 0,
    saldoAntes: S, saldoDepois: S, parcelaAntes: P, parcelaDepois: P, ultimaParcelaDepois: null,
    prazoAntes: n, prazoDepois: n, jurosAntes, jurosDepois: jurosAntes, economia: 0,
    parcelasQuitadas: 0, jurosEmbutidos: 0,
  });
  const quitaTudo = A >= S - EPS;
  const limpo = (v: number) => (Math.abs(v) < 0.005 ? 0 : v);  // sem "-0,00" por arredondamento
  const fechar = (c: CenarioQuitacao) => {
    c.jurosDepois = limpo(c.jurosDepois);
    c.economia = limpo(c.jurosAntes - c.jurosDepois);
    return c;
  };

  // 1) Antecipar as últimas parcelas: cada parcela do fim custa P/(1+i)^j (desconto pela taxa da dívida)
  const ult = base('ultimas');
  {
    let k = 0, custo = 0;
    for (let j = n; j >= 1; j--) {
      const pv = P / Math.pow(1 + i, j);
      if (custo + pv > A + EPS) break;
      custo += pv; k++;
    }
    if (k === 0) {
      ult.aplicavel = false;
      ult.motivo = `O aporte não cobre nem a última parcela trazida a valor presente (R$ ${Math.ceil(P / Math.pow(1 + i, n)).toLocaleString('pt-BR')}).`;
    } else {
      ult.parcelasQuitadas = k;
      ult.aporteUsado = custo;
      ult.sobra = A - custo;
      ult.saldoDepois = S - custo;
      ult.prazoDepois = n - k;
      ult.parcelaDepois = k === n ? 0 : P;
      ult.jurosDepois = P * (n - k) - (S - custo);
    }
  }

  // 2) Pagar as próximas parcelas pelo valor cheio (sem desconto): só adianta o calendário
  const prox = base('proximas');
  {
    const k = Math.min(n, Math.floor(A / P + EPS));
    if (k === 0) {
      prox.aplicavel = false;
      prox.motivo = 'O aporte é menor que uma parcela.';
    } else {
      const pvK = valorPresente(P, i, k);
      prox.parcelasQuitadas = k;
      prox.aporteUsado = k * P;
      prox.sobra = A - k * P;
      prox.saldoDepois = S - pvK;
      prox.prazoDepois = n - k;
      prox.parcelaDepois = k === n ? 0 : P;
      prox.jurosEmbutidos = k * P - pvK;
      // Os juros embutidos nas parcelas pagas agora continuam sendo pagos (no aporte): nada se economiza
      prox.jurosDepois = P * (n - k) - prox.saldoDepois + prox.jurosEmbutidos;  // = P·n − S
    }
  }

  // 3) Amortizar reduzindo a parcela: mesmo prazo, novo saldo S − A, nova parcela pelo Price
  const redP = base('reduzir_parcela');
  if (quitaTudo) {
    redP.aplicavel = false;
    redP.motivo = 'O aporte cobre todo o saldo devedor: veja Quitação total.';
  } else {
    const S2 = S - A;
    const P2 = parcelaPrice(S2, i, n);
    redP.aporteUsado = A; redP.sobra = 0;
    redP.saldoDepois = S2;
    redP.parcelaDepois = P2;
    redP.jurosDepois = P2 * n - S2;
  }

  // 4) Amortizar reduzindo o prazo: mesma parcela; o prazo novo sai mês a mês (a última parcela pode ser menor)
  const redZ = base('reduzir_prazo');
  if (quitaTudo) {
    redZ.aplicavel = false;
    redZ.motivo = 'O aporte cobre todo o saldo devedor: veja Quitação total.';
  } else {
    const S2 = S - A;
    let saldo = S2, meses = 0, pago = 0, ultima = P;
    while (saldo > 0.005 && meses < n) {
      saldo *= 1 + i;
      meses++;
      if (saldo <= P + EPS) { ultima = saldo; pago += saldo; saldo = 0; }
      else { pago += P; saldo -= P; }
    }
    redZ.aporteUsado = A; redZ.sobra = 0;
    redZ.saldoDepois = S2;
    redZ.prazoDepois = meses;
    redZ.ultimaParcelaDepois = Math.abs(ultima - P) > 0.005 ? ultima : null;
    redZ.jurosDepois = pago - S2;
  }

  // 5) Quitação total: paga o saldo devedor a valor presente
  const tot = base('total');
  if (!quitaTudo) {
    tot.aplicavel = false;
    tot.falta = S - A;
    tot.motivo = `Faltam R$ ${Math.ceil(S - A).toLocaleString('pt-BR')} para quitar o saldo devedor.`;
  } else {
    tot.aporteUsado = S;
    tot.sobra = A - S;
    tot.saldoDepois = 0; tot.parcelaDepois = 0; tot.prazoDepois = 0; tot.jurosDepois = 0;
  }

  return [ult, prox, redP, redZ, tot].map(fechar);
}
