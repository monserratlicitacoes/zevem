import { Component, computed, input, model } from '@angular/core';

// Como um lançamento se repete:
// - único: um lançamento só;
// - recorrência: o mesmo valor todo mês, da data do lançamento até a data de término;
// - parcelado: o valor informado é o total, dividido em parcelas mensais.
export type ModoRepeticao = 'unico' | 'recorrencia' | 'parcelado';

export interface Repeticao {
  modo: ModoRepeticao;
  dataFim: string; // AAAA-MM-DD, só na recorrência
  parcelas: number; // só no parcelado
}

export const MAX_MESES_RECORRENCIA = 120;
export const MAX_PARCELAS = 60;

export function repeticaoUnica(): Repeticao {
  return { modo: 'unico', dataFim: '', parcelas: 2 };
}

// Recorrência de `meses` lançamentos a partir de `data` (inclusive).
export function repeticaoRecorrente(data: string, meses = 12): Repeticao {
  const datas = datasMensais(data, meses);
  return { modo: 'recorrencia', dataFim: datas[datas.length - 1] ?? '', parcelas: 2 };
}

// Mesma regra do servidor: mesmo dia em cada mês, ou o último dia quando o mês é mais curto.
export function datasMensais(data: string, n: number): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return [];
  const [a, m, d] = data.split('-').map(Number);
  return Array.from({ length: Math.max(n, 0) }, (_, i) => {
    const ultimoDia = new Date(a, m - 1 + i + 1, 0).getDate();
    const alvo = new Date(a, m - 1 + i, Math.min(d, ultimoDia));
    return `${alvo.getFullYear()}-${String(alvo.getMonth() + 1).padStart(2, '0')}-${String(alvo.getDate()).padStart(2, '0')}`;
  });
}

// Mesma regra do servidor: divide em centavos e as primeiras parcelas levam a sobra.
export function dividirEmParcelas(total: number, n: number): number[] {
  const centavos = Math.round(total * 100);
  const base = Math.floor(centavos / n);
  const sobra = centavos - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < sobra ? 1 : 0)) / 100);
}

export interface PlanoLancamento {
  datas: string[];
  valores: number[];
  erro: string;
}

// Datas e valores de cada lançamento que será criado (ou o motivo de não dar para lançar).
export function planejarLancamentos(data: string, valor: number | null, r: Repeticao): PlanoLancamento {
  const v = Number(valor);
  const vazio = (erro: string): PlanoLancamento => ({ datas: [], valores: [], erro });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return vazio('Informe a data.');
  if (!v || v <= 0) return vazio('Informe um valor maior que zero.');
  if (r.modo === 'recorrencia') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dataFim || '')) return vazio('Informe a data de término da recorrência.');
    if (r.dataFim < data) return vazio('A data de término precisa ser depois da data do lançamento.');
    const datas = datasMensais(data, MAX_MESES_RECORRENCIA + 1).filter((d) => d <= r.dataFim);
    if (datas.length > MAX_MESES_RECORRENCIA) return vazio(`A recorrência pode ter no máximo ${MAX_MESES_RECORRENCIA} meses.`);
    return { datas, valores: datas.map(() => v), erro: '' };
  }
  if (r.modo === 'parcelado') {
    const n = Math.floor(Number(r.parcelas));
    if (!n || n < 1 || n > MAX_PARCELAS) return vazio(`Informe de 1 a ${MAX_PARCELAS} parcelas.`);
    return { datas: datasMensais(data, n), valores: dividirEmParcelas(v, n), erro: '' };
  }
  return { datas: [data], valores: [v], erro: '' };
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const moeda = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesAno = (iso: string) => `${MESES[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`;

@Component({
  selector: 'app-repeticao-gasto',
  templateUrl: './repeticao-gasto.html',
  styleUrl: './repeticao-gasto.scss',
})
export class RepeticaoGasto {
  readonly repeticao = model.required<Repeticao>();
  readonly data = input<string>(''); // data do lançamento (início)
  readonly valor = input<number | null>(null); // na recorrência, valor de cada mês; no parcelado, o total
  readonly nome = input<string>('rep'); // prefixo para ids únicos quando há mais de um na tela

  readonly maxParcelas = MAX_PARCELAS;

  readonly plano = computed(() => planejarLancamentos(this.data(), this.valor(), this.repeticao()));

  readonly resumo = computed(() => {
    const { datas, valores, erro } = this.plano();
    const modo = this.repeticao().modo;
    if (modo === 'unico') return '';
    if (erro) return /valor/.test(erro) ? '' : erro; // sem valor ainda: não incomoda
    const periodo = datas.length > 1 ? `, de ${mesAno(datas[0])} a ${mesAno(datas[datas.length - 1])}` : '';
    if (modo === 'recorrencia') {
      return `${datas.length} ${datas.length === 1 ? 'lançamento' : 'lançamentos'} de ${moeda(valores[0])}${periodo}`;
    }
    const iguais = valores.every((v) => v === valores[0]);
    const parcelas = iguais
      ? `${datas.length}x de ${moeda(valores[0])}`
      : `1x de ${moeda(valores[0])} + ${datas.length - 1}x de ${moeda(valores[valores.length - 1])}`;
    return `${parcelas} = ${moeda(valores.reduce((s, v) => s + v, 0))}${periodo}`;
  });

  readonly resumoComErro = computed(() => {
    const e = this.plano().erro;
    return !!e && this.repeticao().modo !== 'unico' && !/valor/.test(e);
  });

  // Recorrência e parcelado são exclusivos: ligar um desliga o outro.
  alternar(modo: 'recorrencia' | 'parcelado', ligado: boolean) {
    const atual = this.repeticao();
    if (!ligado) { this.repeticao.set({ ...atual, modo: 'unico' }); return; }
    const dataFim = atual.dataFim || repeticaoRecorrente(this.data()).dataFim;
    this.repeticao.set({ ...atual, modo, dataFim, parcelas: atual.parcelas >= 1 ? atual.parcelas : 2 });
  }

  mudarDataFim(v: string) { this.repeticao.set({ ...this.repeticao(), dataFim: v }); }

  mudarParcelas(v: string) { this.repeticao.set({ ...this.repeticao(), parcelas: Number(v) }); }
}
