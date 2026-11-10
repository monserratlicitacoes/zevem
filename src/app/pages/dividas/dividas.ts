import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { environment } from '../../../environments/environment';
import { VideoBadge } from '../../shared/video-badge/video-badge';
import { JarroOrcamento } from '../../shared/jarro-orcamento/jarro-orcamento';

export interface Divida {
  id?: number;
  guia: string;
  nome: string;
  quitado: boolean;
  modalidade: string;
  pmt: number;
  parcelas_totais: number | null;
  parcelas_restantes: number | null;
  quitacao_a_vista: number;
  taxa: string;
  correcao: string;
  criado_em?: string;
}

const MODALIDADES = ['SAC', 'PRICE', 'Outro'];
const CORRECOES   = ['NÃO HÁ', 'IPCA', 'IGP-M', 'TR', 'SELIC', 'INPC'];

interface Guia { id: string; label: string; }

@Component({
  selector: 'app-dividas',
  imports: [FormsModule, VideoBadge, JarroOrcamento],
  templateUrl: './dividas.html',
  styleUrl: './dividas.scss',
})
export class Dividas implements OnInit {
  jarroAberto = false; // modal "Jarro do Orçamento"
  modalidades = MODALIDADES;
  correcoes   = CORRECOES;
  linhasMinimas = 0;

  guias: Guia[] = [
    { id: 'imobilizados',  label: 'Passivos Imobilizados' },
    { id: 'financeiros',   label: 'Passivos Financeiros' },
  ];
  guiaAtiva = 'imobilizados';

  todosDividas: Divida[] = [];
  dividas: Divida[] = [];
  carregando = false;
  adicionando = false;

  private api = `${environment.apiUrl}/dividas`;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef, private route: ActivatedRoute) {}

  ngOnInit() {
    const guia = this.route.snapshot.queryParamMap.get('guia');
    if (guia && this.guias.some(g => g.id === guia)) {
      this.guiaAtiva = guia;
    }
    this.carregar();
  }

  carregar() {
    this.carregando = true;
    this.http.get<Divida[]>(this.api).subscribe({
      next: (lista) => {
        this.todosDividas = lista;
        this.filtrarGuia();
        this.carregando = false;
        this.cdr.detectChanges();
      },
      error: () => { this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  selecionarGuia(id: string) {
    if (id === this.guiaAtiva) return;
    this.guiaAtiva = id;
    this.filtrarGuia();
  }

  filtrarGuia() {
    this.dividas = this.todosDividas.filter(d => d.guia === this.guiaAtiva);
  }

  get linhasVazias(): number[] {
    const faltam = this.linhasMinimas - this.dividas.length;
    return faltam > 0 ? Array.from({ length: faltam }, (_, i) => i) : [];
  }

  get totalPmt(): number {
    return this.dividas.reduce((s, d) => s + (d.pmt || 0), 0);
  }

  totalPmtGuia(id: string): number {
    return this.todosDividas.filter(d => d.guia === id).reduce((s, d) => s + (d.pmt || 0), 0);
  }

  // ── Dashboard ──────────────────────────────────────────────
  modalAberto = false;

  get totalPmtGeral(): number {
    return this.todosDividas.reduce((s, d) => s + (d.pmt || 0), 0);
  }

  get totalQuitacaoGeral(): number {
    return this.todosDividas.reduce((s, d) => s + (d.quitacao_a_vista || 0), 0);
  }

  get dashPorGuia(): { label: string; pmt: number; quitacao: number }[] {
    return this.guias.map(g => ({
      label: g.label,
      pmt: this.todosDividas.filter(d => d.guia === g.id).reduce((s, d) => s + (d.pmt || 0), 0),
      quitacao: this.todosDividas.filter(d => d.guia === g.id).reduce((s, d) => s + (d.quitacao_a_vista || 0), 0),
    }));
  }

  pct(valor: number): string {
    const total = this.totalPmtGeral;
    return total > 0 ? `${Math.round((valor / total) * 100)}%` : '0%';
  }

  // ── Simulador ──────────────────────────────────────────────
  simAberto = false;
  simAba: 'financiamento' | 'taxas' = 'financiamento';

  // Financiamento
  simValor = '';
  simTaxa = '';
  simPrazo = '';
  simModalidade: 'PRICE' | 'SAC' = 'PRICE';
  simCorrecao = 'NENHUM';
  simCorrecaoValor = '';
  readonly indices = ['NENHUM', 'IPCA', 'IGP-M', 'TR', 'SELIC', 'INPC'];

  simResultado: {
    pmt: number; ultimaParcela: number; totalPago: number; totalJuros: number;
    taxaEfetiva: number | null;
    parcelas: { n: number; pmt: number; amort: number; juros: number; saldo: number }[];
  } | null = null;

  // Conversão de taxas
  convValor = '';
  convDe: 'mensal' | 'anual' | 'diaria' = 'mensal';
  convPara: 'mensal' | 'anual' | 'diaria' = 'anual';
  convResultado: { valor: number; label: string } | null = null;

  private parseNum(s: string): number {
    return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  }

  onSimValorBlur(e: Event) {
    const input = e.target as HTMLInputElement;
    const v = this.parseNum(input.value);
    this.simValor = v ? v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    input.value = this.simValor;
  }

  onSimValorFocus(e: Event) {
    const input = e.target as HTMLInputElement;
    const v = this.parseNum(this.simValor);
    input.value = v ? String(v).replace('.', ',') : '';
    this.simValor = input.value;
    input.select();
  }

  fmtSim(v: number): string {
    return Math.round(v).toLocaleString('pt-BR', { useGrouping: true });
  }

  calcularFinanciamento() {
    const pv = this.parseNum(this.simValor);
    const i  = this.parseNum(this.simTaxa) / 100;           // taxa mensal dos juros
    const n  = parseInt(this.simPrazo) || 0;
    if (!pv || !i || !n) { this.simResultado = null; return; }

    // Taxa de correção mensal (via equivalência composta a partir do valor anual estimado)
    const corrAnual = this.simCorrecao !== 'NENHUM' ? this.parseNum(this.simCorrecaoValor) : 0;
    const c = corrAnual > 0 ? Math.pow(1 + corrAnual / 100, 1 / 12) - 1 : 0;

    // Taxa efetiva combinada (Fisher): (1+i)*(1+c)-1
    const iEf = c > 0 ? (1 + i) * (1 + c) - 1 : i;
    const taxaEfetiva = c > 0 ? iEf * 100 : null;

    const parcelas: { n: number; pmt: number; amort: number; juros: number; saldo: number }[] = [];
    let saldo = pv;
    let totalPago = 0;

    if (this.simModalidade === 'PRICE') {
      // PMT calculado com taxa efetiva (inclui correção)
      const pmt = pv * iEf / (1 - Math.pow(1 + iEf, -n));
      for (let k = 1; k <= n; k++) {
        const j = saldo * iEf;
        const a = pmt - j;
        saldo = Math.max(0, saldo - a);
        totalPago += pmt;
        parcelas.push({ n: k, pmt, amort: a, juros: j, saldo });
      }
      this.simResultado = { pmt, ultimaParcela: pmt, totalPago, totalJuros: totalPago - pv, taxaEfetiva, parcelas };
    } else {
      // SAC: amortização fixa; juros calculados sobre saldo com taxa efetiva
      const amort = pv / n;
      let totalJuros = 0;
      for (let k = 1; k <= n; k++) {
        const j = saldo * iEf;
        const pmt = amort + j;
        saldo = Math.max(0, saldo - amort);
        totalJuros += j;
        totalPago += pmt;
        parcelas.push({ n: k, pmt, amort, juros: j, saldo });
      }
      this.simResultado = { pmt: parcelas[0].pmt, ultimaParcela: parcelas[n - 1].pmt, totalPago, totalJuros, taxaEfetiva, parcelas };
    }
  }

  private toMonthly(v: number, de: string): number {
    if (de === 'mensal')  return v / 100;
    if (de === 'anual')   return Math.pow(1 + v / 100, 1 / 12) - 1;
    if (de === 'diaria')  return Math.pow(1 + v / 100, 30) - 1;
    return 0;
  }

  private fromMonthly(m: number, para: string): number {
    if (para === 'mensal')  return m * 100;
    if (para === 'anual')   return (Math.pow(1 + m, 12) - 1) * 100;
    if (para === 'diaria')  return (Math.pow(1 + m, 1 / 30) - 1) * 100;
    return 0;
  }

  readonly periodoLabel: Record<string, string> = {
    mensal: 'a.m.', anual: 'a.a.', diaria: 'a.d.',
  };

  calcularTaxa() {
    const v = this.parseNum(this.convValor);
    if (!v) { this.convResultado = null; return; }
    const mensal = this.toMonthly(v, this.convDe);
    const resultado = this.fromMonthly(mensal, this.convPara);
    this.convResultado = { valor: resultado, label: this.periodoLabel[this.convPara] };
  }

  taxaAnual(taxaMensalPct: number): number {
    return (Math.pow(1 + taxaMensalPct / 100, 12) - 1) * 100;
  }

  fmtTaxa(v: number): string {
    // mostra até 4 casas, remove zeros à direita
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  // Copia a taxa mensal no formato que o campo Taxa da tabela aceita (ex.: "1,0234"), para colar numa linha
  taxaCopiada = false;
  private timerCopia?: ReturnType<typeof setTimeout>;
  async copiarTaxa() {
    if (!this.convResultado) return;
    const texto = this.convResultado.valor.toFixed(4).replace(/\.?0+$/, '').replace('.', ',');
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      // Sem a API de área de transferência (ex.: página sem HTTPS): cópia pelo método antigo
      const area = document.createElement('textarea');
      area.value = texto;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    this.taxaCopiada = true;
    this.cdr.detectChanges();
    clearTimeout(this.timerCopia);
    this.timerCopia = setTimeout(() => { this.taxaCopiada = false; this.cdr.detectChanges(); }, 2000);
  }

  fmt(v: number): string {
    return v ? Math.round(v).toLocaleString('pt-BR') : '';
  }

  onValorBlur(e: Event, d: Divida, campo: 'pmt' | 'quitacao_a_vista') {
    const raw = (e.target as HTMLInputElement).value.replace(/[^\d,]/g, '').replace(',', '.');
    d[campo] = raw ? Math.round(parseFloat(raw)) : 0;
    (e.target as HTMLInputElement).value = d[campo] ? this.fmt(d[campo]) : '';
    if (campo === 'pmt') this.calcularQuitacao(d);
    this.salvarLinha(d);
  }

  onTaxaFocus(e: Event, d: Divida) {
    const input = e.target as HTMLInputElement;
    const num = this.parseTaxa(d.taxa);
    input.value = num !== null ? (num * 100).toFixed(2).replace('.', ',') : '';
    input.select();
  }

  onTaxaBlur(e: Event, d: Divida) {
    const input = e.target as HTMLInputElement;
    const raw = input.value.replace(',', '.').trim();
    const num = parseFloat(raw);
    if (!isNaN(num) && num > 0) {
      d.taxa = num.toFixed(2).replace('.', ',') + '% a.m.';
    } else if (!raw) {
      d.taxa = '';
    }
    input.value = d.taxa;
    this.calcularQuitacao(d);
    this.salvarLinha(d);
  }

  onModalidadeChange(d: Divida) {
    this.calcularQuitacao(d);
    this.salvarLinha(d);
  }

  onInteiroBlur(e: Event, d: Divida, campo: 'parcelas_totais' | 'parcelas_restantes') {
    const raw = (e.target as HTMLInputElement).value.replace(/\D/g, '');
    d[campo] = raw ? parseInt(raw) : null;
    this.calcularQuitacao(d);
    this.salvarLinha(d);
  }

  parseTaxa(taxa: string): number | null {
    const match = taxa.replace(',', '.').match(/([\d.]+)\s*%/);
    if (!match) return null;
    return parseFloat(match[1]) / 100;
  }

  calcularQuitacao(d: Divida): void {
    const i = this.parseTaxa(d.taxa);
    const n = d.parcelas_restantes;
    const pmt = d.pmt;
    if (!i || !n || !pmt || !d.modalidade) return;

    let saldo = 0;
    if (d.modalidade === 'PRICE') {
      saldo = pmt * (1 - Math.pow(1 + i, -n)) / i;
    } else if (d.modalidade === 'SAC') {
      saldo = pmt * n / (1 + n * i);
    } else {
      return;
    }
    d.quitacao_a_vista = Math.round(saldo);
  }

  adicionarLinha() {
    if (this.adicionando) return;
    this.adicionando = true;
    const nova: Partial<Divida> = {
      guia: this.guiaAtiva, nome: '', quitado: false,
      modalidade: '', pmt: 0, parcelas_totais: null,
      parcelas_restantes: null, quitacao_a_vista: 0, taxa: '', correcao: 'NÃO HÁ',
    };
    this.http.post<Divida>(this.api, nova).subscribe({
      next: (d) => {
        this.todosDividas = [...this.todosDividas, d];
        this.filtrarGuia();
        this.adicionando = false;
        this.cdr.detectChanges();
      },
      error: () => { this.adicionando = false; this.cdr.detectChanges(); },
    });
  }

  salvarLinha(d: Divida) {
    if (!d.id) return;
    this.http.put<Divida>(`${this.api}/${d.id}`, d).subscribe({
      next: (atualizado) => {
        const i = this.dividas.findIndex(x => x.id === d.id);
        if (i >= 0) this.dividas[i] = atualizado;
        const j = this.todosDividas.findIndex(x => x.id === d.id);
        if (j >= 0) this.todosDividas[j] = atualizado;
        this.cdr.detectChanges();
      },
    });
  }

  excluirLinha(d: Divida) {
    if (!d.id) return;
    this.http.delete(`${this.api}/${d.id}`).subscribe({
      next: () => {
        this.dividas = this.dividas.filter(x => x.id !== d.id);
        this.todosDividas = this.todosDividas.filter(x => x.id !== d.id);
        this.cdr.detectChanges();
      },
    });
  }
}
