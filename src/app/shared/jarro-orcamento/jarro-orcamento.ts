import { ChangeDetectorRef, Component, HostListener, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { DashboardService } from '../../services/dashboard.service';

// "Jarro do Orçamento": o gráfico de orçamento mensal do Dashboard, aberto como modal nas telas que
// o alimentam. A parte que a tela gera fica em destaque; as demais ficam esmaecidas.
// Letras = componentes do orçamento no backend (componentesOrcamento em server.js):
//   A..G camadas da pilha (de baixo para cima); H receita mensal (contorno contínuo); I receita total (tracejado).
export type ParteOrcamento = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';

interface Camada { letra: ParteOrcamento; rotulo: string; cor: string; }

// Mesmas cores e ordem do Dashboard
const CAMADAS: Camada[] = [
  { letra: 'A', rotulo: 'Passivo Patrimonial', cor: '#ff2e63' },
  { letra: 'B', rotulo: 'Passivo Financeiro', cor: '#ffa3b8' },
  { letra: 'C', rotulo: 'Mensal Comprometido', cor: '#05261a' },
  { letra: 'D', rotulo: 'Mensal Flexível', cor: '#0b3d2e' },
  { letra: 'E', rotulo: 'Eventual Flexível', cor: '#39d353' },
  { letra: 'F', rotulo: 'Eventual Comprometido', cor: '#7fa88f' },
  { letra: 'G', rotulo: 'M.I.M.', cor: '#b8f15a' },
];

// Desenho em unidades fixas (o SVG escala com a largura do modal)
const G = { w: 300, h: 380, x0: 74, x1: 290, y0: 12, y1: 368, barra: 104, contorno: 124 };

@Component({
  selector: 'app-jarro-orcamento',
  imports: [],
  templateUrl: './jarro-orcamento.html',
  styleUrl: './jarro-orcamento.scss',
})
export class JarroOrcamento implements OnInit {
  private service = inject(DashboardService);
  private cdr = inject(ChangeDetectorRef);

  destaque = input<ParteOrcamento[]>([]);
  origem = input(''); // nome da tela, para o subtítulo
  // Painel master: os números de um cliente já carregados (sem buscar o orçamento de quem está logado)
  componentes = input<Partial<Record<ParteOrcamento, number>> | null>(null);
  cliente = input('');
  fechar = output<void>();

  readonly g = G;
  carregando = signal(true);
  erro = signal('');
  private valores = signal<Partial<Record<ParteOrcamento, number>>>({});

  ngOnInit() {
    const dados = this.componentes();
    if (dados) { this.valores.set(dados); this.carregando.set(false); return; }
    this.service.obter().subscribe({
      next: (d) => { this.valores.set(d.nivel_saude?.componentes ?? {}); this.carregando.set(false); this.cdr.detectChanges(); },
      error: () => { this.erro.set('Não foi possível carregar o orçamento.'); this.carregando.set(false); this.cdr.detectChanges(); },
    });
  }

  @HostListener('document:keydown.escape')
  aoEsc() { this.fechar.emit(); }

  valor(l: ParteOrcamento): number { return this.valores()[l] ?? 0; }
  emDestaque(l: ParteOrcamento): boolean { return this.destaque().includes(l); }
  get receitaMensal(): number { return this.valor('H'); }
  get receitaTotal(): number { return this.valor('I'); }

  // Topo do eixo: maior entre a pilha e as receitas, com 10% de folga (como no Dashboard)
  teto = computed(() => {
    const v = this.valores();
    const pilha = CAMADAS.reduce((s, c) => s + (v[c.letra] ?? 0), 0);
    return Math.max(pilha, v.H ?? 0, v.I ?? 0, 1) * 1.1;
  });
  marcas = computed(() => {
    const teto = this.teto();
    const bruto = teto / 5;
    const exp = Math.pow(10, Math.floor(Math.log10(bruto)));
    const f = bruto / exp;
    const passo = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
    const m: number[] = [];
    for (let x = 0; x <= teto + 1e-6; x += passo) m.push(x);
    return m;
  });
  y(v: number): number { return G.y1 - (v / this.teto()) * (G.y1 - G.y0); }
  get centro(): number { return (G.x0 + G.x1) / 2; }

  segmentos = computed(() => {
    let acumulado = 0;
    return CAMADAS.map((c) => {
      const base = acumulado;
      acumulado += this.valor(c.letra);
      return { ...c, valor: this.valor(c.letra), y: this.y(acumulado), h: this.y(base) - this.y(acumulado) };
    });
  });
  // Legenda na ordem da pilha, de cima para baixo
  legenda = computed(() => [...this.segmentos()].reverse());
  totalDestaque = computed(() => CAMADAS.filter((c) => this.emDestaque(c.letra)).reduce((s, c) => s + this.valor(c.letra), 0));
  // Saldo = receita − tudo o que a pilha consome (A..G, M.I.M. incluído)
  totalPilha = computed(() => CAMADAS.reduce((s, c) => s + this.valor(c.letra), 0));
  get saldoMensal(): number { return this.receitaMensal - this.totalPilha(); }
  get saldoTotal(): number { return this.receitaTotal - this.totalPilha(); }
  get destacaReceitas(): boolean { return this.emDestaque('H') || this.emDestaque('I'); }

  pct(v: number): number { return this.receitaMensal > 0 ? Math.round((v / this.receitaMensal) * 100) : 0; }
  moeda(v: number): string { return Math.round(v || 0).toLocaleString('pt-BR'); }
  // Com sinal de menos antes do R$ quando negativo
  moedaSaldo(v: number): string { return (Math.round(v) < 0 ? '− ' : '') + 'R$ ' + this.moeda(Math.abs(v)); }
}
