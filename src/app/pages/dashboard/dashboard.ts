import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, WritableSignal, inject, signal } from '@angular/core';
import { Diagnostico, diagnosticoComprometimento } from './diagnostico-comprometimento';
import { diagnosticoSaude } from './diagnostico-saude';
import { DashboardService, GrauComprometimento, NivelSaude } from '../../services/dashboard.service';
import { VideoBadge } from '../../shared/video-badge/video-badge';
import { TemaService } from '../../services/tema.service';

// Dashboard: visão geral em painéis (orçamento mensal empilhado, base de plena
// liquidez, limite do cartão e dois velocímetros).
// Cada painel lê só o objeto `dados`, preenchido com o que vem de /dashboard.

// Explicação mostrada ao passar o mouse na legenda. Trechos entre ** saem em negrito;
// um * no fim indica valor mensalizado (ver NOTA_MENSALIZADO).
// letra: componente do orçamento vindo do backend (ver componentesOrcamento em server.js)
interface Camada { rotulo: string; letra: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'; valor: number; cor: string; explicacao: string; }
interface TrechoTexto { texto: string; negrito: boolean; }

const NOTA_MENSALIZADO = '* Valor anual dividido por 12, para comparar mês a mês.';
interface Faixa { de: number; ate: number; cor: string; rotulo: string; }
interface Velocimetro {
  id: 'comprometimento' | 'saude';
  titulo: string; corTitulo: string; textoTitulo: string;
  min: number; max: number; valor: number; sufixo: string; faixas: Faixa[];
}


// Paleta Zevem para os gráficos. Fundos claros; os tons escuros ficam para os destaques
// (barras e marcações). Do mais escuro ao mais claro: profundo, floresta, apple, lima.
const COR = {
  profundo: '#05261a', floresta: '#0b3d2e', apple: '#39d353', lima: '#b8f15a', salvia: '#7fa88f', offWhite: '#f7f8f5',
  rosa: '#ff2e63', rosaClaro: '#ffa3b8', neutro: '#d5dfd0',
};
// Fundos escuros pedem rótulo claro dentro da barra
const CORES_ESCURAS = new Set([COR.profundo, COR.floresta, COR.rosa, '#4f8a2e', '#5d8f3a']);

// Versão noturna: fundo verde quase preto e o lima como destaque. As cores claras viram tons
// que aparecem no escuro, mantendo a ordem de intensidade de cada gráfico.
const NOITE_CAMADA: Record<string, string> = { [COR.profundo]: COR.lima, [COR.floresta]: '#4f8a2e', [COR.lima]: '#eaffd0' };
const NOITE_DESTAQUE: Record<string, string> = { [COR.floresta]: COR.lima, [COR.apple]: '#5d8f3a' };

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [VideoBadge],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit, AfterViewInit, OnDestroy {
  // Tamanho real dos gráficos (orçamento e os de barra pequenos): o desenho usa 1 unidade = 1px,
  // então a fonte da escala fica sempre do mesmo tamanho e cada gráfico ocupa o cartão inteiro.
  larguraCol = signal(200);
  alturaCol = signal(180);
  larguraOrc = signal(360);
  alturaOrc = signal(420);
  private observadores: ResizeObserver[] = [];

  constructor(private el: ElementRef<HTMLElement>, private cdr: ChangeDetectorRef, private service: DashboardService) {}

  // ── Dados reais ──
  // Todos os painéis vêm do banco (orçamento, liquidez, cartão, Grau de Comprometimento e Nível de Saúde).
  gc: GrauComprometimento | null = null;
  saude: NivelSaude | null = null;

  ngOnInit() {
    this.service.obter().subscribe({
      next: (d) => {
        this.gc = d.grau_comprometimento;
        this.dados.limiteCartao = d.limite_cartao ?? 0;
        const coresBpl = [COR.floresta, COR.apple];
        this.dados.bpl = (d.base_plena_liquidez ?? []).map((p, i) => ({
          nome: p.nome, valor: p.valor, cor: coresBpl[i % coresBpl.length], faltando: p.faltando,
        }));
        const vel = this.dados.velocimetros.find((v) => v.id === 'comprometimento');
        if (vel) vel.valor = Math.round(this.gc.percentual ?? 0);
        this.saude = d.nivel_saude;
        const velSaude = this.dados.velocimetros.find((v) => v.id === 'saude');
        if (velSaude) velSaude.valor = this.saude.nivel ?? velSaude.min;
        // Orçamento mensal: as mesmas partes usadas no Nível de Saúde (eventuais já divididos por 12)
        const comp = this.saude.componentes;
        this.dados.orcamento.camadas.forEach((c) => { c.valor = comp[c.letra] ?? 0; });
        this.dados.orcamento.receitaMensal = comp.H ?? 0;
        this.dados.orcamento.receitaTotal = comp.I ?? 0;
        this.cdr.detectChanges();
      },
    });
  }

  // Sem renda mensal cadastrada não há como calcular os indicadores
  semDados(g: Velocimetro): boolean {
    if (g.id === 'comprometimento') return !!this.gc && this.gc.percentual === null;
    return !!this.saude && this.saude.nivel === null;
  }

  // Explicação do nível de saúde (aparece ao passar o mouse no mostrador)
  motivo(g: Velocimetro): string { return g.id === 'saude' && this.saude ? this.saude.motivo : ''; }

  pct(v: number | null): string { return v === null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`; }

  // "2026-11" → "nov/26"
  mesCurto(chave: string): string {
    const [a, m] = chave.split('-').map(Number);
    return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][m - 1]}/${String(a).slice(2)}`;
  }

  ngAfterViewInit() {
    this.acompanharTamanho('.area-bpl .grafico-px', this.larguraCol, this.alturaCol, 140, 120);
    this.acompanharTamanho('.cartao-orcamento .grafico-orc', this.larguraOrc, this.alturaOrc, 220, 200);
  }

  // Mede o elemento e guarda o tamanho nos signals. A medida é aplicada logo depois da
  // renderização, com redesenho explícito (como nas outras páginas do app): uma medição feita
  // durante a renderização não dispararia atualização.
  private acompanharTamanho(seletor: string, largura: WritableSignal<number>, altura: WritableSignal<number>, minL: number, minA: number) {
    const alvo = this.el.nativeElement.querySelector<SVGElement>(seletor);
    if (!alvo) return;
    const aplicar = (l: number, a: number) => setTimeout(() => {
      const w = Math.max(minL, Math.round(l));
      const h = Math.max(minA, Math.round(a));
      if (w === largura() && h === altura()) return;
      largura.set(w);
      altura.set(h);
      this.cdr.detectChanges();
    });
    const caixa = alvo.getBoundingClientRect();
    aplicar(caixa.width, caixa.height); // medição inicial
    if (typeof ResizeObserver !== 'undefined') {
      const obs = new ResizeObserver(([e]) => aplicar(e.contentRect.width, e.contentRect.height));
      obs.observe(alvo);
      this.observadores.push(obs);
    }
  }

  ngOnDestroy() { this.observadores.forEach((o) => o.disconnect()); }


  dados = {
    orcamento: {
      // De baixo para cima, na ordem da pilha
      camadas: [
        { rotulo: 'Passivo Patrimonial', letra: 'A', valor: 0, cor: COR.rosa, explicacao: 'Parcelas de financiamentos de bens' },
        { rotulo: 'Passivo Financeiro', letra: 'B', valor: 0, cor: COR.rosaClaro, explicacao: 'Parcelas de empréstimos' },
        { rotulo: 'Mensal Comprometido', letra: 'C', valor: 0, cor: COR.profundo, explicacao: 'Gastos que você tem todo mês **com** data fixa' },
        { rotulo: 'Mensal Flexível', letra: 'D', valor: 0, cor: COR.floresta, explicacao: 'Gastos que você tem todo mês **sem** data fixa' },
        { rotulo: 'Eventual Flexível', letra: 'E', valor: 0, cor: COR.apple, explicacao: 'Gastos que você **não** tem todo mês, **sem** data fixa*' },
        { rotulo: 'Eventual Comprometido', letra: 'F', valor: 0, cor: COR.salvia, explicacao: 'Gastos que você **não** tem todo mês, **com** data fixa*' },
        { rotulo: 'M.I.M.', letra: 'G', valor: 0, cor: COR.lima, explicacao: 'Meta de Investimento Mensal' },
      ] as Camada[],
      receitaMensal: 0,
      receitaTotal: 0,
    },
    bpl: [] as { nome: string; valor: number; cor: string; faltando: string[] }[],
    limiteCartao: 0,
    velocimetros: [
      {
        id: 'comprometimento',
        titulo: 'Grau de Comprometimento do Orçamento', corTitulo: '#e9f0e4', textoTitulo: COR.profundo,
        min: 0, max: 100, valor: 54, sufixo: '',
        // mesmas faixas do diagnóstico: < 40 saudável, 40–60 moderado, > 60 elevado
        faixas: [
          { de: 0, ate: 40, cor: COR.floresta, rotulo: 'Saudável' },
          { de: 40, ate: 60, cor: COR.salvia, rotulo: 'Moderado' },
          { de: 60, ate: 100, cor: COR.rosa, rotulo: 'Elevado' },
        ],
      },
      {
        id: 'saude',
        titulo: 'Nível de Saúde do Orçamento Familiar', corTitulo: '#e9f0e4', textoTitulo: COR.profundo,
        min: 1, max: 9, valor: 7, sufixo: '',
        faixas: [
          { de: 1, ate: 3.5, cor: COR.rosa, rotulo: 'Ruim' },
          { de: 3.5, ate: 6.5, cor: COR.salvia, rotulo: 'Regular' },
          { de: 6.5, ate: 9, cor: COR.floresta, rotulo: 'Ótimo' },
        ],
      },
    ] as Velocimetro[],
  };

  readonly cores = COR;

  // ── Versão noturna: vale para o app inteiro (TemaService), o botão fica só aqui ──
  private tema = inject(TemaService);
  get noturno(): boolean { return this.tema.noturno(); }
  alternarTema() { this.tema.alternar(); }
  // Camadas do orçamento e destaques (barras, velocímetros) no tema atual
  tomCamada(cor: string): string { return this.noturno ? NOITE_CAMADA[cor] ?? cor : cor; }
  tomDestaque(cor: string): string { return this.noturno ? NOITE_DESTAQUE[cor] ?? cor : cor; }
  // Rótulo da faixa sob o valor: a sálvia é clara demais para texto no claro e escura demais no noturno
  corRotuloFaixa(cor: string): string {
    if (cor === COR.salvia) return this.noturno ? '#b9d3c2' : COR.floresta;
    return this.tomDestaque(cor);
  }

  // ── Verso dos velocímetros: diagnóstico conforme o valor ──
  virados = new Set<string>();
  // Modal com o texto completo do diagnóstico
  diagnosticoAberto: Velocimetro | null = null;
  abrirDiagnostico(g: Velocimetro) { this.diagnosticoAberto = g; }
  fecharDiagnostico() { this.diagnosticoAberto = null; }
  @HostListener('document:keydown.escape') aoEsc() { this.fecharDiagnostico(); }
  alternarVirado(id: string) { this.virados.has(id) ? this.virados.delete(id) : this.virados.add(id); }
  diagnostico(g: Velocimetro): Diagnostico | null {
    if (g.id === 'comprometimento') return diagnosticoComprometimento(g.valor);
    if (g.id === 'saude') return diagnosticoSaude(this.saude?.nivel ?? null);
    return null;
  }
  // "… está em {v}." → trechos, com o valor em destaque
  trechosValor(texto: string, g: Velocimetro): { texto: string; valor: boolean }[] {
    const partes = texto.split('{v}');
    return partes.flatMap((t, i) => i < partes.length - 1
      ? [{ texto: t, valor: false }, { texto: `${g.valor}%`, valor: true }]
      : [{ texto: t, valor: false }]).filter((p) => p.texto);
  }

  // Cor do rótulo dentro de uma barra: claro sobre tons escuros, verde profundo sobre os claros
  corRotulo(fundo: string): string { return CORES_ESCURAS.has(fundo) ? COR.offWhite : COR.profundo; }

  // ── Formatação ──
  moeda(v: number | null | undefined): string {
    if (!v) return '-';
    return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  // ── Eixo: teto "redondo" e marcações (5 intervalos) ──
  eixo(maximo: number, intervalos = 5): number[] {
    const bruto = Math.max(maximo, 1) / intervalos;
    const exp = Math.pow(10, Math.floor(Math.log10(bruto)));
    const f = bruto / exp;
    const passo = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
    const teto = Math.max(passo, Math.ceil(maximo / passo) * passo);
    const marcas: number[] = [];
    for (let v = 0; v <= teto + passo / 2; v += passo) marcas.push(v);
    return marcas;
  }

  // ── Orçamento mensal (coluna empilhada + contornos das receitas) ──
  // Geometria do orçamento: altura do cartão inteiro; espaço à esquerda para a escala
  get orc() {
    const w = this.larguraOrc(), h = this.alturaOrc();
    const x0 = 78, x1 = w - 10;
    // Largura da coluna fixa (como antes); só a altura acompanha o cartão
    const barra = Math.round(Math.min(115, (x1 - x0) * 0.5));
    return { x0, x1, y0: 12, y1: h - 12, barra, contorno: barra + 20 };
  }
  // Topo do eixo Y: o maior entre receita total, receita mensal e a soma dos pagamentos (a pilha),
  // mais 10% de folga. As linhas da escala ficam em valores redondos até esse topo.
  get orcTeto(): number {
    const o = this.dados.orcamento;
    const pagamentos = o.camadas.reduce((s, c) => s + c.valor, 0);
    return Math.max(pagamentos, o.receitaTotal, o.receitaMensal, 1) * 1.1;
  }
  get orcMarcas(): number[] {
    const teto = this.orcTeto;
    const bruto = teto / 5;
    const exp = Math.pow(10, Math.floor(Math.log10(bruto)));
    const f = bruto / exp;
    const passo = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
    const marcas: number[] = [];
    for (let v = 0; v <= teto + 1e-6; v += passo) marcas.push(v);
    return marcas;
  }
  orcY(v: number): number {
    return this.orc.y1 - (v / this.orcTeto) * (this.orc.y1 - this.orc.y0);
  }
  get orcSegmentos() {
    let acumulado = 0;
    return this.dados.orcamento.camadas.map((c) => {
      const base = acumulado;
      acumulado += c.valor;
      return { ...c, y: this.orcY(acumulado), h: this.orcY(base) - this.orcY(acumulado) };
    });
  }
  get orcCentro(): number { return (this.orc.x0 + this.orc.x1) / 2; }

  // ── Colunas simples/empilhadas genéricas (BPL e cartão) ──
  // Gráficos de barra pequenos (liquidez e cartão): proporção compacta, escala abreviada
  get col() {
    const w = this.larguraCol();
    return { x0: 50, x1: w - 6, y0: 10, y1: this.alturaCol() - 12, barra: Math.min(96, Math.round((w - 56) * 0.75)) };
  }
  get colCentro(): number { return (this.col.x0 + this.col.x1) / 2; }

  // Escala abreviada: 100.000 → "100 mil", 12.500 → "12,5 mil"
  escalaCurta(v: number): string {
    if (!v) return '0';
    if (v >= 1000) return `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
    return v.toLocaleString('pt-BR');
  }
  colY(v: number, marcas: number[]): number {
    const teto = marcas[marcas.length - 1];
    return this.col.y1 - (v / teto) * (this.col.y1 - this.col.y0);
  }

  get bplTotal(): number { return this.dados.bpl.reduce((s, p) => s + p.valor, 0); }
  // Dados já carregados e ninguém cadastrado: o gráfico mostra um aviso no lugar da escala
  get bplSemPessoas(): boolean { return !!this.saude && !this.dados.bpl.length; }
  get bplMarcas(): number[] { return this.eixo(this.bplTotal); }
  // Rótulo dentro da faixa quando ela cabe o texto; faixa fina no topo leva o rótulo acima da barra,
  // faixa fina no meio fica sem rótulo (o valor continua na dica ao passar o mouse).
  get bplSegmentos() {
    const ALTURA_MIN_ROTULO = 22;
    let acumulado = 0;
    const segs = this.dados.bpl.map((p) => {
      const base = acumulado;
      acumulado += p.valor;
      const y = this.colY(acumulado, this.bplMarcas);
      return { ...p, y, h: this.colY(base, this.bplMarcas) - y };
    });
    const topo = segs.reduce((i, s, j) => (s.h > 0 ? j : i), -1);
    return segs.map((s, j) => {
      const dentro = s.h >= ALTURA_MIN_ROTULO;
      const fora = !dentro && j === topo;
      return { ...s, rotulo: dentro ? 'dentro' : fora ? 'fora' : null, rotuloY: dentro ? s.y + s.h / 2 + 4 : s.y - 6 };
    });
  }

  get cartaoMarcas(): number[] { return this.eixo(this.dados.limiteCartao); }

  // ── Velocímetro: arco de 270° (de baixo-esquerda a baixo-direita) ──
  // Arco de 240° (de baixo-esquerda a baixo-direita), com espaço no centro para o valor
  readonly vel = { cx: 110, cy: 106, r: 76, anel: 90 };
  private angulo(g: Velocimetro, v: number): number {
    const t = Math.min(1, Math.max(0, (v - g.min) / (g.max - g.min)));
    return (210 - 240 * t) * Math.PI / 180;
  }
  private ponto(a: number, r: number): [number, number] {
    return [this.vel.cx + r * Math.cos(a), this.vel.cy - r * Math.sin(a)];
  }
  arco(g: Velocimetro, de: number, ate: number, raio = this.vel.r): string {
    const a0 = this.angulo(g, de), a1 = this.angulo(g, ate);
    const [x0, y0] = this.ponto(a0, raio);
    const [x1, y1] = this.ponto(a1, raio);
    const grande = Math.abs(a0 - a1) > Math.PI ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${raio} ${raio} 0 ${grande} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  // Faixa em que o valor está (fora da escala, a última/primeira)
  faixaAtual(g: Velocimetro): Faixa {
    return g.faixas.find((f) => g.valor >= f.de && g.valor <= f.ate)
      ?? (g.valor > g.max ? g.faixas[g.faixas.length - 1] : g.faixas[0]);
  }
  // Trecho preenchido: do início da escala até o valor
  arcoValor(g: Velocimetro): string {
    return this.arco(g, g.min, Math.min(g.max, Math.max(g.min + (g.max - g.min) * 0.001, g.valor)));
  }
  marcador(g: Velocimetro): { x: number; y: number } {
    const [x, y] = this.ponto(this.angulo(g, g.valor), this.vel.r);
    return { x, y };
  }

  // ── Legenda: de cima para baixo, na mesma ordem da pilha (receitas, depois do topo à base) ──
  get legendaCamadas(): Camada[] { return [...this.dados.orcamento.camadas].reverse(); }

  readonly explicacaoReceitaMensal = 'Receitas que você tem todo mês';
  readonly explicacaoReceitaTotal = 'Receitas que você tem todo mês, somadas às que você **não** tem todo mês*';
  readonly notaMensalizado = NOTA_MENSALIZADO;

  // "Gastos que você **não** tem" → trechos com e sem negrito (sem usar innerHTML)
  trechos(texto: string): TrechoTexto[] {
    return texto.replace(/\*$/, '').split('**').map((t, i) => ({ texto: t, negrito: i % 2 === 1 })).filter((t) => t.texto);
  }
  mensalizado(texto: string): boolean { return texto.endsWith('*') && !texto.endsWith('**'); }

  // Quanto cada parte consome da receita mensal (barra de proporção na legenda)
  pctReceita(v: number): number {
    const r = this.dados.orcamento.receitaMensal;
    return r > 0 ? Math.round((v / r) * 100) : 0;
  }
}
