import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { VideoBadge } from '../../shared/video-badge/video-badge';

export interface Ativo {
  id?: number;
  guia: string;
  nome: string;
  valor_aquisicao: number;
  valor_atual: number;
  rendimento_mensal: number;
  taxa: string;
  correcao: string;
  classe: string; // só ativos financeiros
}

export interface Passivo {
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
}

const CORRECOES = ['NÃO HÁ', 'IPCA', 'IGP-M', 'TR', 'SELIC', 'INPC'];
const CORRECOES_IMOB = ['VALORIZAÇÃO', 'DESVALORIZAÇÃO'];
const MODALIDADES = ['SAC', 'PRICE', 'Outro'];
const CLASSES_ATIVO = ['Pós Fixado', 'Pré Fixado', 'Inflação', 'Fundo Multimercado', 'FII', 'Ações', 'Alternativo'];

interface Guia { id: string; label: string; tipo: 'ativo' | 'passivo'; guiaBackend: string; }

@Component({
  selector: 'app-ativos-passivos',
  imports: [FormsModule, VideoBadge],
  templateUrl: './ativos-passivos.html',
  styleUrl: './ativos-passivos.scss',
})
export class AtivosPassivos implements OnInit {
  correcoes = CORRECOES;
  correcoesImob = CORRECOES_IMOB;
  modalidades = MODALIDADES;
  classesAtivo = CLASSES_ATIVO;
  modalAberto = false;
  linhasMinimas = 0;

  guias: Guia[] = [
    { id: 'ativos_imobilizados',   label: 'Ativos Imobilizados',   tipo: 'ativo',   guiaBackend: 'imobilizados' },
    { id: 'ativos_financeiros',    label: 'Ativos Financeiros',    tipo: 'ativo',   guiaBackend: 'financeiros'  },
    { id: 'passivos_imobilizados', label: 'Passivos Imobilizados', tipo: 'passivo', guiaBackend: 'imobilizados' },
    { id: 'passivos_financeiros',  label: 'Passivos Financeiros',  tipo: 'passivo', guiaBackend: 'financeiros'  },
  ];
  guiaAtiva = 'ativos_imobilizados';

  todosAtivos: Ativo[] = [];
  todosPassivos: Passivo[] = [];

  ativos: Ativo[] = [];
  passivos: Passivo[] = [];

  carregando = false;
  adicionando = false;
  private tempId = -1;

  private apiAtivos   = `${environment.apiUrl}/ativos`;
  private apiPassivos = `${environment.apiUrl}/dividas`;

  origemGuia: Record<string, { rota: string; params?: Record<string,string>; label: string }> = {
    passivos_imobilizados: { rota: '/dividas', params: { guia: 'imobilizados' }, label: 'Dívidas' },
    passivos_financeiros:  { rota: '/dividas', params: { guia: 'financeiros'  }, label: 'Dívidas' },
  };

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef, public router: Router) {}

  ngOnInit() { this.carregar(); }

  carregar() {
    this.carregando = true;
    let done = 0;
    const check = () => { if (++done === 2) { this.filtrar(); this.carregando = false; this.cdr.detectChanges(); } };

    this.http.get<Ativo[]>(this.apiAtivos).subscribe({
      next: (lista) => { this.todosAtivos = lista; check(); },
      error: () => check(),
    });
    this.http.get<Passivo[]>(this.apiPassivos).subscribe({
      next: (lista) => { this.todosPassivos = lista; check(); },
      error: () => check(),
    });
  }

  get guiaInfo(): Guia { return this.guias.find(g => g.id === this.guiaAtiva)!; }
  get tipoAtivo(): boolean { return this.guiaInfo.tipo === 'ativo'; }

  selecionarGuia(id: string) {
    if (id === this.guiaAtiva) return;
    this.guiaAtiva = id;
    this.filtrar();
  }

  filtrar() {
    const g = this.guiaInfo;
    if (g.tipo === 'ativo') {
      this.ativos = this.todosAtivos.filter(a => a.guia === g.guiaBackend);
    } else {
      this.passivos = this.todosPassivos.filter(p => p.guia === g.guiaBackend);
    }
  }

  get linhasAtivos():   Ativo[]   { return this.ativos; }
  get linhasPassivos(): Passivo[] { return this.passivos; }

  get linhasVazias(): number[] {
    const faltam = this.linhasMinimas - (this.tipoAtivo ? this.ativos.length : this.passivos.length);
    return faltam > 0 ? Array.from({ length: faltam }, (_, i) => i) : [];
  }

  // ── Totais por guia (para aba) ────────────────────────────
  totalGuia(id: string): number {
    const g = this.guias.find(x => x.id === id)!;
    if (g.tipo === 'ativo') {
      return this.todosAtivos.filter(a => a.guia === g.guiaBackend).reduce((s, a) => s + (a.valor_atual || 0), 0);
    } else {
      return this.todosPassivos.filter(p => p.guia === g.guiaBackend).reduce((s, p) => s + (p.pmt || 0), 0);
    }
  }

  totalLabelGuia(id: string): string {
    if (id === 'ativos_financeiros') return 'Investido';
    return this.guias.find(x => x.id === id)?.tipo === 'ativo' ? 'Val. Atual' : 'PMT';
  }

  // ── Totais da aba ativa ───────────────────────────────────
  get totalValorAtual(): number  { return this.ativos.reduce((s, a) => s + (a.valor_atual || 0), 0); }
  get totalPmt(): number         { return this.passivos.reduce((s, p) => s + (p.pmt || 0), 0); }

  fmt(v: number): string { return v ? Math.round(v).toLocaleString('pt-BR') : ''; }

  // ── Ativos Imobilizados: valor projetado em 12 meses ──────
  valor12meses(a: Ativo): number {
    const t = this.parseTaxa(a.taxa);
    if (!t || !a.valor_atual) return a.valor_atual || 0;
    if (a.correcao === 'DESVALORIZAÇÃO') {
      return Math.round(a.valor_atual * Math.pow(1 - t, 12));
    }
    return Math.round(a.valor_atual * Math.pow(1 + t, 12));
  }

  // ── Resumo / Dashboard ────────────────────────────────────
  get totalAtivoImob(): number {
    return this.todosAtivos.filter(a => a.guia === 'imobilizados').reduce((s, a) => s + (a.valor_atual || 0), 0);
  }
  get totalAtivoFin(): number {
    return this.todosAtivos.filter(a => a.guia === 'financeiros').reduce((s, a) => s + (a.valor_atual || 0), 0);
  }
  get totalPassivoImob(): number {
    return this.todosPassivos.filter(p => p.guia === 'imobilizados').reduce((s, p) => s + (p.quitacao_a_vista || 0), 0);
  }
  get totalPassivoFin(): number {
    return this.todosPassivos.filter(p => p.guia === 'financeiros').reduce((s, p) => s + (p.quitacao_a_vista || 0), 0);
  }
  get patrimonioLiquido(): number {
    return (this.totalAtivoImob + this.totalAtivoFin) - (this.totalPassivoImob + this.totalPassivoFin);
  }
  barPct(v: number): number {
    const max = Math.max(this.totalAtivoImob, this.totalAtivoFin, this.totalPassivoImob, this.totalPassivoFin, 1);
    return Math.round((v / max) * 100);
  }

  onValorBlur(e: Event, obj: any, campo: string) {
    const raw = (e.target as HTMLInputElement).value.replace(/\./g, '').replace(',', '.');
    obj[campo] = raw ? Math.round(parseFloat(raw)) : 0;
    (e.target as HTMLInputElement).value = obj[campo] ? this.fmt(obj[campo]) : '';
    this.salvar(obj);
  }

  // ── Passivos: taxa & cálculo ─────────────────────────────
  parseTaxa(taxa: string): number | null {
    const m = taxa.replace(',', '.').match(/([\d.]+)\s*%/);
    return m ? parseFloat(m[1]) / 100 : null;
  }

  onTaxaFocus(e: Event, obj: any) {
    const input = e.target as HTMLInputElement;
    const num = this.parseTaxa(obj.taxa);
    input.value = num !== null ? (num * 100).toFixed(2).replace('.', ',') : '';
    input.select();
  }

  onTaxaBlur(e: Event, obj: any) {
    const input = e.target as HTMLInputElement;
    const raw = input.value.replace(',', '.').trim();
    const num = parseFloat(raw);
    obj.taxa = !isNaN(num) && num > 0 ? num.toFixed(2).replace('.', ',') + '% a.m.' : '';
    input.value = obj.taxa;
    if (!this.tipoAtivo) this.calcularQuitacao(obj as Passivo);
    this.salvar(obj);
  }

  calcularQuitacao(p: Passivo) {
    const i = this.parseTaxa(p.taxa);
    const n = p.parcelas_restantes;
    if (!i || !n || !p.pmt || !p.modalidade) return;
    if (p.modalidade === 'PRICE') {
      p.quitacao_a_vista = Math.round(p.pmt * (1 - Math.pow(1 + i, -n)) / i);
    } else if (p.modalidade === 'SAC') {
      p.quitacao_a_vista = Math.round(p.pmt * n / (1 + n * i));
    }
  }

  onModalidadeChange(p: Passivo) { this.calcularQuitacao(p); this.salvar(p); }

  onInteiroBlur(e: Event, p: Passivo, campo: 'parcelas_totais' | 'parcelas_restantes') {
    const raw = (e.target as HTMLInputElement).value.replace(/\D/g, '');
    p[campo] = raw ? parseInt(raw) : null;
    this.calcularQuitacao(p);
    this.salvar(p);
  }

  // ── CRUD ─────────────────────────────────────────────────
  adicionarLinha() {
    if (this.adicionando) return;
    const g = this.guiaInfo;

    if (g.tipo === 'ativo') {
      // Atualização otimista: linha aparece imediatamente
      const correcaoPadrao = g.id === 'ativos_imobilizados' ? 'VALORIZAÇÃO' : 'NÃO HÁ';
      const tid = this.tempId--;
      const temp: Ativo = { id: tid, guia: g.guiaBackend, nome: '', valor_aquisicao: 0, valor_atual: 0, rendimento_mensal: 0, taxa: '', correcao: correcaoPadrao, classe: '' };
      this.todosAtivos = [...this.todosAtivos, temp];
      this.filtrar();
      this.cdr.detectChanges();

      this.adicionando = true;
      const body = { guia: g.guiaBackend, nome: '', valor_aquisicao: 0, valor_atual: 0, rendimento_mensal: 0, taxa: '', correcao: correcaoPadrao, classe: '' };
      this.http.post<Ativo>(this.apiAtivos, body).subscribe({
        next: (a) => {
          this.todosAtivos = this.todosAtivos.map(x => x.id === tid ? a : x);
          this.filtrar();
          this.adicionando = false;
          this.cdr.detectChanges();
        },
        error: () => {
          // mantém a linha local para o usuário não perder o contexto
          this.adicionando = false;
          this.cdr.detectChanges();
        },
      });
    } else {
      this.adicionando = true;
      const nova = { guia: g.guiaBackend, nome: '', quitado: false, modalidade: '', pmt: 0, parcelas_totais: null, parcelas_restantes: null, quitacao_a_vista: 0, taxa: '', correcao: 'NÃO HÁ' };
      this.http.post<Passivo>(this.apiPassivos, nova).subscribe({
        next: (p) => {
          this.todosPassivos = [...this.todosPassivos, p];
          this.filtrar();
          this.adicionando = false;
          this.cdr.detectChanges();
        },
        error: () => { this.adicionando = false; this.cdr.detectChanges(); },
      });
    }
  }

  salvar(obj: Ativo | Passivo) {
    if (!obj.id || (obj.id as number) < 0) return;
    const isAtivo = 'valor_atual' in obj;
    const api = isAtivo ? `${this.apiAtivos}/${obj.id}` : `${this.apiPassivos}/${obj.id}`;
    this.http.put<any>(api, obj).subscribe({
      next: (updated) => {
        if (isAtivo) {
          this.todosAtivos = this.todosAtivos.map(a => a.id === obj.id ? updated : a);
        } else {
          this.todosPassivos = this.todosPassivos.map(p => p.id === obj.id ? { ...updated, quitado: !!updated.quitado } : p);
        }
        this.filtrar();
        this.cdr.detectChanges();
      },
    });
  }

  excluir(obj: Ativo | Passivo) {
    if (!obj.id) return;
    const isAtivo = 'valor_atual' in obj;
    if (obj.id < 0) {
      this.todosAtivos = this.todosAtivos.filter(a => a.id !== obj.id);
      this.filtrar();
      return;
    }
    const api = isAtivo ? `${this.apiAtivos}/${obj.id}` : `${this.apiPassivos}/${obj.id}`;
    this.http.delete(api).subscribe({
      next: () => {
        if (isAtivo) {
          this.todosAtivos = this.todosAtivos.filter(a => a.id !== obj.id);
        } else {
          this.todosPassivos = this.todosPassivos.filter(p => p.id !== obj.id);
        }
        this.filtrar();
        this.cdr.detectChanges();
      },
    });
  }
}
