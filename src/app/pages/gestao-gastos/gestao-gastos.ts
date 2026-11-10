import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { Subscription, forkJoin, timeout } from 'rxjs';
import { CATEGORIA_NAO_IDENTIFICADO, CLASSES_GASTO, Gasto, GastoService, NOME_NAO_IDENTIFICADO } from '../../services/gasto.service';
import {
  PlanoLancamento, Repeticao, RepeticaoGasto, datasMensais, planejarLancamentos, repeticaoRecorrente, repeticaoUnica,
} from '../../shared/repeticao-gasto/repeticao-gasto';
import { PessoaService, Pessoa } from '../../services/pessoa.service';
import {
  GastoSuspenso, GestaoGastos as DadosGestao, GestaoGastosService, MensalEventual, LancamentoGasto, LancamentoReceita, ParcelaGasto, ResumoImportacao, TipoAjuste, SugestaoMeta } from '../../services/gestao-gastos.service';
import { Router } from '@angular/router';
import { mimSonho } from '../../shared/calculo-sonhos';
import { MascaraMoeda } from '../../shared/mascara-moeda';
import { VideoBadge } from '../../shared/video-badge/video-badge';

type Status = 'vazio' | 'ok' | 'estourou' | 'neutro';

interface ItemLinha {
  gasto: Gasto;
  nome: string;
  meta: number;
  meses: number[]; // realizado por mês (índice 0 = janeiro)
}

// Linha prevista da Gestão de Pagamentos (dívida, outras dívidas ou investimento): vem com o valor
// previsto em cada mês e aceita ajuste mês a mês.
interface LinhaPrevista {
  tipo: TipoAjuste;
  refId: number;
  nome: string;
  meta: number;
  previsto: number[];
  ajuste: (number | null)[];
  destino: string | null; // tela onde a meta é definida (a meta não se edita aqui)
  guia?: string;          // dívida: aba do cadastro de passivos (imobilizados / financeiros)
}

interface OpcaoItem {
  item: ItemLinha;
  categoria: string;
}

interface CategoriaLinha {
  id: string;
  label: string;
  itens: ItemLinha[];
  meta: number;
  meses: number[];
}

// Mesma ordem e nomes das abas da tela Gastos.
const CATEGORIAS_INICIO = [
  { id: 'moradia', label: 'Moradia' },
  { id: 'transporte', label: 'Transporte' },
  { id: 'vida-saude', label: 'Vida e Saúde' },
  { id: 'lazer-doacoes', label: 'Lazer' },
  { id: 'alimentacao', label: 'Alimentação FDC' },
  { id: 'assinaturas', label: 'Assinaturas' },
];
const CATEGORIAS_FIM = [
  { id: 'dependentes', label: 'Dependentes' },
  { id: 'empresa', label: 'Empresa' },
  { id: CATEGORIA_NAO_IDENTIFICADO, label: NOME_NAO_IDENTIFICADO },
];

interface ParcelaMes {
  id: number;
  descricao: string;
  item: string;
  categoria: string;
  parcela: number | null;
  total_parcelas: number | null;
  valor: number;
  ultima: boolean;
}
interface MesParcelado {
  idx: number; // ano * 12 + mês
  rotulo: string; // "outubro de 2026"
  total: number;
  itens: ParcelaMes[];
  terminam: number; // compras cuja última parcela cai neste mês
}

export const MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MESES_NOME = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

@Component({
  selector: 'app-gestao-gastos',
  imports: [FormsModule, NgTemplateOutlet, RepeticaoGasto, MascaraMoeda, VideoBadge],
  templateUrl: './gestao-gastos.html',
  styleUrl: './gestao-gastos.scss',
})
export class GestaoGastos implements OnInit {
  readonly mesesAbrev = MESES_ABREV;
  readonly hoje = new Date();
  ano = this.hoje.getFullYear();
  // Colunas da grade: cada uma é um mês absoluto (ano × 12 + mês). No ano atual a grade vai de janeiro
  // até 12 meses depois do mês anterior (ex.: jan/26 a set/27) e abre rolada no mês anterior; nos
  // outros anos, janeiro a dezembro. Os índices `m` usados na tela são posições nessas colunas.
  colunas: number[] = [];
  private readonly hojeIdx = this.hoje.getFullYear() * 12 + this.hoje.getMonth();
  mesFoco = 0; // coluna dos cards de resumo
  carregando = false;
  erro = '';

  categorias: CategoriaLinha[] = [];
  // Todas as categorias, inclusive as vazias (para criar item novo em qualquer uma).
  defsCategorias: { id: string; label: string }[] = [];
  // Para criar item: todas menos a categoria fixa, que não aceita itens novos.
  get categoriasParaNovoItem() { return this.defsCategorias.filter((d) => d.id !== CATEGORIA_NAO_IDENTIFICADO); }
  // Cards do topo escondidos para dar espaço à tabela (preferência guardada no navegador).
  resumoRecolhido = this.lerPreferencia('gestao-resumo-recolhido');
  abertas = new Set<string>();
  private pessoas: Pessoa[] = [];

  // Painel de lançamentos da célula clicada
  celula: { item: ItemLinha; mes: number } | null = null;
  lancamentos: LancamentoGasto[] = [];
  carregandoLancamentos = false;
  erroLancamentos = '';
  erroLancamento = '';
  novo = { data: '', valor: null as number | null, descricao: '', repeticao: repeticaoUnica() };
  novoAberto = false; // o formulário de novo lançamento abre só quando o usuário clica

  // Modal "Lançar gasto"
  modalAberto = false;
  busca = '';
  sugestoesAbertas = false;
  indiceSugestao = 0;
  itemModal: OpcaoItem | null = null;
  modal = { valor: null as number | null, data: '', descricao: '', repeticao: repeticaoUnica() };
  erroModal = '';
  avisoSucesso = '';

  constructor(
    private service: GestaoGastosService,
    private pessoaService: PessoaService,
    private gastoService: GastoService,
    private cdr: ChangeDetectorRef,
    private router: Router,
  ) {}

  get visaoRolante(): boolean { return this.ano === this.hoje.getFullYear(); }

  private definirPeriodo() {
    const anterior = this.hojeIdx - 1;
    const inicio = this.visaoRolante ? Math.floor(anterior / 12) * 12 : this.ano * 12;
    const fim = this.visaoRolante ? anterior + 12 : inicio + 11;
    this.colunas = Array.from({ length: fim - inicio + 1 }, (_, k) => inicio + k);
  }

  private colunaDe(indiceMes: number): number { return indiceMes - (this.colunas[0] ?? 0); }
  private chaveColuna(m: number): string {
    const abs = this.colunas[m];
    return `${Math.floor(abs / 12)}-${this.dois((abs % 12) + 1)}`;
  }
  rotuloColuna(m: number): string {
    const abs = this.colunas[m];
    return this.visaoRolante ? `${MESES_ABREV[abs % 12]}/${String(Math.floor(abs / 12)).slice(2)}` : MESES_ABREV[abs % 12];
  }
  // "outubro" ou "outubro de 2027" (quando não é o ano corrente).
  nomeMesColuna(m: number): string {
    const abs = this.colunas[m];
    const ano = Math.floor(abs / 12);
    return MESES_NOME[abs % 12] + (ano !== this.hoje.getFullYear() ? ` de ${ano}` : '');
  }
  ngOnInit() {
    this.definirPeriodo();
    this.mesFoco = this.colunaDe(this.hojeIdx);
    this.carregarSuspensos();
    this.pessoaService.listar().subscribe({
      next: (lista) => { this.pessoas = lista; this.carregar(); },
      error: () => this.carregar(),
    });
  }

  carregar() {
    this.carregando = true;
    this.erro = '';
    this.service.obter(this.chaveColuna(0), this.chaveColuna(this.colunas.length - 1)).subscribe({
      next: (dados) => {
        this.montar(dados.itens, dados.realizados);
        this.montarMensalEventuais(dados.mensal_eventuais ?? []);
        this.montarPagamentos(dados);
        this.carregando = false;
        this.cdr.detectChanges();
        if (this.rolarAoCarregar) { this.rolarAoCarregar = false; this.rolarGradeParaMesAnterior(); }
      },
      error: (e) => {
        this.erro = e?.status === 0
          ? 'Sem conexão com o servidor. Verifique se o backend está ligado e recarregue a página.'
          : 'Não foi possível carregar a gestão de gastos.';
        this.carregando = false;
        this.cdr.detectChanges();
      },
    });
  }

  private montar(itens: Gasto[], realizados: { gasto_id: number; chave: string; total: number }[]) {
    const n = this.colunas.length;
    const porItem = new Map<number, number[]>();
    for (const r of realizados) {
      const col = this.colunaDe(this.indiceMes(r.chave));
      if (col < 0 || col >= n) continue;
      if (!porItem.has(r.gasto_id)) porItem.set(r.gasto_id, Array(n).fill(0));
      porItem.get(r.gasto_id)![col] = r.total;
    }
    const [p1, p2] = this.pessoas;
    const defs = [
      ...CATEGORIAS_INICIO,
      { id: 'pessoa-1', label: p1 ? p1.nome.trim().split(/\s+/)[0] : 'Adulto' },
      { id: 'pessoa-2', label: p2 ? p2.nome.trim().split(/\s+/)[0] : 'Cônjuge' },
      ...CATEGORIAS_FIM,
    ];
    this.defsCategorias = defs;
    this.categorias = defs
      .map((d) => {
        const linhas: ItemLinha[] = itens
          .filter((g) => g.categoria === d.id && (g.descricao?.trim() || g.valor || porItem.has(g.id!)))
          .map((g) => ({
            gasto: g,
            nome: g.descricao?.trim() || 'Item sem nome',
            meta: g.valor_mensal ?? g.valor ?? 0,
            meses: porItem.get(g.id!) ?? Array(n).fill(0),
          }));
        return {
          id: d.id,
          label: d.label,
          itens: linhas,
          meta: linhas.reduce((s, i) => s + i.meta, 0),
          meses: Array.from({ length: n }, (_, m) => linhas.reduce((s, i) => s + i.meses[m], 0)),
        };
      })
      .filter((c) => c.itens.length);
  }

  // ── Gastos eventuais: limite anual móvel ────────────────────
  // Regra: nenhum período de 12 meses consecutivos pode passar da meta anual. Cada gasto conta no mês
  // em que cai (à vista no mês dele, parcelado parcela a parcela). O disponível num mês M é o limite
  // menos a soma da janela mais cheia entre as 12 que contêm M (de M-11..M até M..M+11). Assim um
  // gasto continua pesando por 12 meses e as parcelas futuras já descontam do limite.
  private mensalPorItem = new Map<number, Map<number, number>>();

  private montarMensalEventuais(linhas: MensalEventual[]) {
    this.mensalPorItem.clear();
    for (const l of linhas) {
      if (!this.mensalPorItem.has(l.gasto_id)) this.mensalPorItem.set(l.gasto_id, new Map());
      this.mensalPorItem.get(l.gasto_id)!.set(this.indiceMes(l.mes), l.total);
    }
  }

  // AAAA-MM(-DD) → número sequencial de meses, para comparar e somar intervalos.
  private indiceMes(iso: string): number {
    const [a, m] = iso.split('-').map(Number);
    return a * 12 + (m - 1);
  }

  private rotuloMes(indice: number): string {
    return `${MESES_ABREV[indice % 12].toLowerCase()}/${String(Math.floor(indice / 12)).slice(2)}`;
  }

  janela(i: ItemLinha, m: number) { return this.janelaNoMes(i, this.colunas[m]); }

  // Mesmo cálculo, para qualquer mês (índice sequencial), inclusive de outros anos.
  private janelaNoMes(i: ItemLinha, alvo: number): { inicio: number; fim: number; soma: number; limite: number; disponivel: number } {
    const limite = i.gasto.valor || 0;
    const porMes = this.mensalPorItem.get(i.gasto.id!) ?? new Map<number, number>();
    let pior = { inicio: alvo, fim: alvo + 11, soma: -1 };
    for (let inicio = alvo - 11; inicio <= alvo; inicio++) {
      let soma = 0;
      for (let k = inicio; k < inicio + 12; k++) soma += porMes.get(k) ?? 0;
      if (soma > pior.soma) pior = { inicio, fim: inicio + 11, soma };
    }
    const soma = Math.round(pior.soma * 100) / 100;
    return { inicio: pior.inicio, fim: pior.fim, soma, limite, disponivel: Math.round((limite - soma) * 100) / 100 };
  }

  // ── Editar a meta direto na grade ───────────────────────────
  // Mensal: valor por mês. Eventual: valor por ano (o mesmo que a coluna mostra com "/ano").
  editandoMeta: ItemLinha | null = null;
  valorMetaEditando: number | null = null;
  erroMeta = '';
  private salvandoMeta = false;

  abrirEdicaoMeta(it: ItemLinha) {
    if (this.naoIdentificado(it) || this.editandoMeta === it) return;
    this.editandoMeta = it;
    this.valorMetaEditando = it.gasto.valor || null;
    this.erroMeta = '';
    this.cdr.detectChanges();
    // O ngModel preenche o campo no tick seguinte: seleciona depois, para a digitação substituir o valor.
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.input-meta');
      input?.focus();
      input?.select();
    });
  }

  cancelarEdicaoMeta() { this.editandoMeta = null; this.erroMeta = ''; }

  // ── Ajuste automático das metas pelo histórico ──
  // Abre uma prévia (meta atual × sugerida, com a base do cálculo); o usuário escolhe o que aplicar.
  ajusteMetas: { carregando: boolean; erro: string; referencia: string; itens: (SugestaoMeta & { aplicar: boolean; nome: string; categoriaNome: string })[] } | null = null;
  aplicandoAjuste = false;

  abrirAjusteMetas() {
    this.ajusteMetas = { carregando: true, erro: '', referencia: '', itens: [] };
    this.service.sugestaoMetas().subscribe({
      next: (r) => {
        const ordem = this.defsCategorias.map((d) => d.id);
        const itens = r.sugestoes
          .map((s) => ({
            ...s,
            nome: s.descricao?.trim() || 'Item sem nome',
            categoriaNome: this.defsCategorias.find((d) => d.id === s.categoria)?.label ?? s.categoria,
            aplicar: s.sugerido !== s.atual,
          }))
          .sort((a, b) => ordem.indexOf(a.categoria) - ordem.indexOf(b.categoria));
        this.ajusteMetas = { carregando: false, erro: '', referencia: r.referencia, itens };
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.ajusteMetas = { carregando: false, erro: e?.status === 0 ? 'Sem conexão com o servidor.' : 'Não foi possível calcular as sugestões.', referencia: '', itens: [] };
        this.cdr.detectChanges();
      },
    });
  }

  fecharAjusteMetas() { if (!this.aplicandoAjuste) this.ajusteMetas = null; }

  get qtdAjusteSelecionados(): number { return this.ajusteMetas?.itens.filter((i) => i.aplicar && i.sugerido !== i.atual).length ?? 0; }
  get todosAjusteMarcados(): boolean {
    const mudam = this.ajusteMetas?.itens.filter((i) => i.sugerido !== i.atual) ?? [];
    return mudam.length > 0 && mudam.every((i) => i.aplicar);
  }
  marcarTodosAjuste(marcar: boolean) { this.ajusteMetas?.itens.forEach((i) => (i.aplicar = marcar && i.sugerido !== i.atual)); }

  baseAjuste(s: SugestaoMeta): string {
    const mes = (k: string) => this.rotuloMes(this.indiceMes(k));
    if (s.base.tipo === 'media') {
      const b = s.base;
      return `Média de ${b.considerados} ${b.considerados === 1 ? 'mês' : 'meses'} com gasto: ` + b.meses.map((m) => `${mes(m.mes)} ${m.total ? this.moeda(m.total) : '—'}`).join(' · ');
    }
    const b = s.base;
    return `${this.moeda(b.soma)} em ${b.meses_observados} ${b.meses_observados === 1 ? 'mês' : 'meses'} (${mes(b.de)} a ${mes(b.ate)}), projetado para 12 meses`;
  }

  aplicarAjusteMetas() {
    const sel = this.ajusteMetas?.itens.filter((i) => i.aplicar && i.sugerido !== i.atual) ?? [];
    if (!sel.length || this.aplicandoAjuste) return;
    const porId = new Map(this.categorias.flatMap((c) => c.itens).map((it) => [it.gasto.id!, it.gasto]));
    this.aplicandoAjuste = true;
    forkJoin(sel.map((s) => {
      const g = porId.get(s.id);
      return this.gastoService.atualizar(s.id, { descricao: g?.descricao ?? s.descricao, com_cartao: g?.com_cartao ?? false, classe: s.classe, valor: s.sugerido,
        dia_vencimento: g?.dia_vencimento ?? null, mes_vencimento: g?.mes_vencimento ?? null });
    })).subscribe({
      next: () => {
        this.aplicandoAjuste = false;
        this.ajusteMetas = null;
        this.mostrarAviso(`${sel.length} ${sel.length === 1 ? 'meta ajustada' : 'metas ajustadas'} pelo histórico.`);
        this.carregar();
      },
      error: () => {
        this.aplicandoAjuste = false;
        if (this.ajusteMetas) this.ajusteMetas.erro = 'Não foi possível aplicar todas as metas. Confira e tente de novo.';
        this.carregar();
        this.cdr.detectChanges();
      },
    });
  }

  salvarMeta(it: ItemLinha) {
    if (this.editandoMeta !== it || this.salvandoMeta) return;
    const valor = Math.max(0, Number(this.valorMetaEditando) || 0);
    if (valor === (it.gasto.valor || 0)) { this.cancelarEdicaoMeta(); return; }
    const anterior = { ...it.gasto };
    const aplicarNaGrade = (g: Gasto) => {
      it.gasto = { ...it.gasto, ...g };
      it.meta = g.valor_mensal ?? g.valor ?? 0;
      const cat = this.categorias.find((c) => c.itens.includes(it));
      if (cat) cat.meta = cat.itens.reduce((s, x) => s + x.meta, 0);
    };
    // Atualiza na hora; se o servidor recusar, volta o valor anterior e mostra o erro.
    aplicarNaGrade({ ...it.gasto, valor, valor_mensal: this.eventual(it) ? Math.round(valor / 12) : valor });
    this.editandoMeta = null;
    this.salvandoMeta = true;
    this.gastoService.atualizar(it.gasto.id!, {
      descricao: it.gasto.descricao, com_cartao: it.gasto.com_cartao, classe: it.gasto.classe, valor,
      dia_vencimento: it.gasto.dia_vencimento ?? null, mes_vencimento: it.gasto.mes_vencimento ?? null,
    }).subscribe({
      next: (g) => {
        this.salvandoMeta = false;
        aplicarNaGrade(g);
        this.mostrarAviso(`Meta de "${it.nome}" atualizada para ${this.moeda(valor)}${this.eventual(it) ? ' por ano' : ' por mês'}.`);
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.salvandoMeta = false;
        aplicarNaGrade(anterior);
        this.editandoMeta = it;
        this.valorMetaEditando = valor;
        this.erroMeta = e?.status === 0 ? 'Sem conexão com o servidor.' : e?.error?.erro || 'Não foi possível salvar.';
        this.cdr.detectChanges();
      },
    });
  }

  // ── Resumo (cards) ──────────────────────────────────────────
  get metaMensal(): number { return this.categorias.reduce((s, c) => s + c.meta, 0); }
  get realizadoMes(): number { return this.categorias.reduce((s, c) => s + c.meses[this.mesFoco], 0); }
  get percentualMes(): number { return this.percentual(this.realizadoMes, this.metaMensal); }
  // Acumulado de janeiro do ano do mês em foco até ele.
  private get colunaJaneiroFoco(): number {
    return Math.max(0, this.colunaDe(Math.floor(this.colunas[this.mesFoco] / 12) * 12));
  }
  get mesesDecorridos(): number { return this.mesFoco - this.colunaJaneiroFoco + 1; }
  get metaAcumulada(): number { return this.metaMensal * this.mesesDecorridos; }
  get realizadoAcumulado(): number {
    return this.categorias.reduce((s, c) => s + c.meses.slice(this.colunaJaneiroFoco, this.mesFoco + 1).reduce((a, b) => a + b, 0), 0);
  }
  get abrevMesFoco(): string { return MESES_ABREV[this.colunas[this.mesFoco] % 12].toLowerCase(); }
  get percentualAcumulado(): number { return this.percentual(this.realizadoAcumulado, this.metaAcumulada); }
  get itensEstourados(): ItemLinha[] {
    return this.categorias.flatMap((c) => c.itens)
      .filter((i) => !this.naoIdentificado(i))
      .filter((i) => this.status(this.realizadoItem(i, this.mesFoco), this.metaItemMes(i, this.mesFoco)) === 'estourou');
  }
  totalMes(m: number): number { return this.categorias.reduce((s, c) => s + c.meses[m], 0); }
  get nomeMesFoco(): string { return this.nomeMesColuna(this.mesFoco); }

  // ── Sinalização ─────────────────────────────────────────────
  // Itens eventuais: a janela de 12 meses mais cheia que contém o mês × limite anual (ver janela()).
  // Os mensais comparam o mês com a meta mensal.
  eventual(i: ItemLinha): boolean { return !!i.gasto.classe?.startsWith('Eventual'); }
  // Meta exibida na coluna (anual nos eventuais).
  metaItem(i: ItemLinha): number { return this.eventual(i) ? i.gasto.valor || 0 : i.meta; }
  // Meta usada no progresso do mês (nos eventuais, o limite anual).
  metaItemMes(i: ItemLinha, m: number): number { return this.eventual(i) ? i.gasto.valor || 0 : i.meta; }
  realizadoItem(i: ItemLinha, m: number): number {
    return this.eventual(i) ? this.janela(i, m).soma : i.meses[m];
  }
  // "Não Identificado" não tem meta: mostra o valor sem sinalização de meta.
  naoIdentificado(i: ItemLinha): boolean { return i.gasto.categoria === CATEGORIA_NAO_IDENTIFICADO; }
  statusCategoria(c: CategoriaLinha, v: number): Status {
    return c.id === CATEGORIA_NAO_IDENTIFICADO ? (v ? 'neutro' : 'vazio') : this.status(v, c.meta);
  }
  get painelStatus(): Status {
    if (this.celula && this.naoIdentificado(this.celula.item)) return this.painelRealizado ? 'neutro' : 'vazio';
    return this.status(this.painelRealizado, this.painelMeta);
  }

  // Painel de item eventual: o disponível e, sem disponível, até quando evitar gastar.
  get painelJanela() { return this.celula && this.painelEventual ? this.janela(this.celula.item, this.celula.mes) : null; }

  // Último mês sem disponível, olhando para frente: o mês anterior ao primeiro em que o limite volta a ter
  // saldo. Parcelas futuras podem prolongar o bloqueio além do período mais cheio.
  evitarAte(i: ItemLinha, m: number): string {
    const inicio = this.colunas[m];
    for (let k = inicio + 1; k <= inicio + 48; k++) {
      if (this.janelaNoMes(i, k).disponivel > 0) return this.rotuloMesLongo(k - 1);
    }
    return this.rotuloMesLongo(inicio + 48);
  }

  private rotuloMesLongo(indice: number): string {
    return `${MESES_NOME[indice % 12]} de ${Math.floor(indice / 12)}`;
  }
  rotuloJanela(j: { inicio: number; fim: number }): string {
    return j.inicio === j.fim ? this.rotuloMes(j.fim) : `${this.rotuloMes(j.inicio)} a ${this.rotuloMes(j.fim)}`;
  }

  statusCelula(i: ItemLinha, m: number): Status {
    if (this.naoIdentificado(i)) return i.meses[m] ? 'neutro' : 'vazio';
    return i.meses[m] ? this.status(this.realizadoItem(i, m), this.metaItemMes(i, m)) : 'vazio';
  }
  dicaItem(i: ItemLinha, m: number): string {
    if (this.naoIdentificado(i)) return i.meses[m] ? `${this.moeda(i.meses[m])} classificados como Não Identificado` : 'Nada lançado';
    if (!this.eventual(i)) return this.dicaCelula(i.meses[m], i.meta);
    const j = this.janela(i, m);
    const mes = i.meses[m] ? `${this.moeda(i.meses[m])} neste mês · ` : '';
    if (!j.limite) return `${mes}Sem meta anual`;
    const p = this.percentual(j.soma, j.limite);
    return `${mes}Janela mais cheia (${this.rotuloJanela(j)}): ${this.moeda(j.soma)} de ${this.moeda(j.limite)} (${p}%)` +
      (j.disponivel < 0 ? ` — passou ${this.moeda(-j.disponivel)}` : ` — disponível ${this.moeda(j.disponivel)}`);
  }

  percentual(realizado: number, meta: number): number {
    if (!meta) return realizado > 0 ? 100 : 0;
    return Math.round((realizado / meta) * 100);
  }

  // Binário: até a meta (inclusive) = dentro (verde); acima da meta = estourou (rosa elétrico).
  // Compara pelo percentual arredondado que aparece na tela: quem mostra 100% fica verde
  // (ex.: parcela de R$ 158,33 numa meta de R$ 158).
  status(realizado: number, meta: number): Status {
    if (!realizado) return 'vazio';
    if (!meta) return 'estourou';
    if (this.percentual(realizado, meta) > 100) return 'estourou';
    return 'ok';
  }

  mesFuturo(m: number): boolean { return this.colunas[m] > this.hojeIdx; }

  dicaCelula(realizado: number, meta: number): string {
    if (!realizado) return meta ? `Meta de ${this.moeda(meta)} — nada lançado` : 'Nada lançado';
    const p = this.percentual(realizado, meta);
    if (!meta) return `${this.moeda(realizado)} sem meta definida`;
    return p > 100
      ? `Estourou: ${p}% da meta (${this.moeda(realizado - meta)} acima)`
      : `${p}% da meta (restam ${this.moeda(meta - realizado)})`;
  }

  // ── Interações ──────────────────────────────────────────────
  alternar(id: string) {
    this.abertas.has(id) ? this.abertas.delete(id) : this.abertas.add(id);
  }

  get todasAbertas(): boolean { return this.categorias.length > 0 && this.categorias.every((c) => this.abertas.has(c.id)); }

  alternarTodas() {
    if (this.todasAbertas) this.abertas.clear();
    else this.categorias.forEach((c) => this.abertas.add(c.id));
  }

  focarMes(m: number) { this.mesFoco = m; }

  alternarResumo() {
    this.resumoRecolhido = !this.resumoRecolhido;
    try { localStorage.setItem('gestao-resumo-recolhido', this.resumoRecolhido ? '1' : '0'); } catch {}
  }

  private lerPreferencia(chave: string): boolean {
    try { return localStorage.getItem(chave) === '1'; } catch { return false; }
  }

  // A grade abre rolada com o mês anterior ao atual como primeira coluna de mês visível (logo após
  // as colunas fixas de nome e meta). Só na abertura e ao trocar de ano, não a cada recarga de dados.
  private rolarAoCarregar = true;

  // Rola a grade para que o mês anterior ao de referência seja a primeira coluna de mês visível
  // (dá contexto: o mês de referência aparece logo em seguida).
  private rolarGradeParaMesAnterior() {
    const wrap = document.querySelector<HTMLElement>('app-gestao-gastos .tabela-wrap');
    if (!wrap) return;
    const colunas = wrap.querySelectorAll<HTMLElement>('thead th.col-mes');
    const meta = wrap.querySelector<HTMLElement>('thead th.col-meta');
    const alvo = colunas[Math.max(0, this.mesFoco - 1)];
    if (!alvo || !meta) return;
    // Medido na tela: a coluna de meta é fixa (sticky), então o deslocamento vale com a grade já rolada.
    wrap.scrollLeft = Math.max(0, wrap.scrollLeft + alvo.getBoundingClientRect().left - meta.getBoundingClientRect().right);
  }

  // ── Gestão de Pagamentos: receitas, dívidas, investimentos e saldo ──
  receitaMeta = 0;
  receitasMes: number[] = [];
  linhasDividas: LinhaPrevista[] = [];
  linhaInvestimento: LinhaPrevista | null = null;
  macrosAbertos = new Set<string>(['gastos', 'dividas', 'investimentos']);

  private montarPagamentos(d: DadosGestao) {
    const n = this.colunas.length;
    const chaves = this.colunas.map((_, m) => this.chaveColuna(m));
    this.receitaMeta = d.receita_planejada ?? 0;
    const porChave = new Map((d.receitas_realizadas ?? []).map((r) => [r.chave, r.total]));
    this.receitasMes = chaves.map((k) => porChave.get(k) ?? 0);

    const ajustes = new Map((d.ajustes ?? []).map((a) => [`${a.tipo}:${a.ref_id}:${a.chave}`, a.valor]));
    const linha = (tipo: TipoAjuste, refId: number, nome: string, meta: number, previsto: number[], destino: string | null): LinhaPrevista => ({
      tipo, refId, nome, meta, previsto, destino,
      ajuste: chaves.map((k) => ajustes.has(`${tipo}:${refId}:${k}`) ? ajustes.get(`${tipo}:${refId}:${k}`)! : null),
    });

    // Dívida: PMT nos meses em que há parcela. As parcelas restantes contam a partir do mês atual;
    // as já pagas (totais − restantes) ficam nos meses anteriores. Sem essas informações, todos os meses.
    this.linhasDividas = (d.dividas ?? []).map((dv) => {
      const restantes = dv.parcelas_restantes;
      const totais = dv.parcelas_totais;
      const inicio = restantes != null && totais != null ? this.hojeIdx - Math.max(0, totais - restantes) : -Infinity;
      const fim = restantes != null ? this.hojeIdx + restantes - 1 : Infinity;
      const previsto = this.colunas.map((abs) => (abs >= inicio && abs <= fim ? dv.pmt : 0));
      return { ...linha('divida', dv.id, dv.nome || 'Dívida sem nome', dv.pmt, previsto, '/dividas'), guia: dv.guia };
    });
    const metaOutras = d.outras_dividas_meta ?? 0;
    this.linhasDividas.push(linha('outras_dividas', 0, 'Outras Dívidas', metaOutras, Array(n).fill(metaOutras), null));

    const mim = Math.round((d.sonhos ?? []).reduce((t, so) => t + (mimSonho(so) ?? 0), 0));
    // Investimento: o valor de cada mês começa em zero e o usuário informa quanto investiu (a meta segue o M.I.M.)
    this.linhaInvestimento = linha('investimento', 0, 'Meta de Investimento Mensal', mim, Array(n).fill(0), '/sonhos');
  }

  valorLinha(l: LinhaPrevista, m: number): number { return l.ajuste[m] ?? l.previsto[m]; }
  // Investimento não tem "previsto" para comparar: o valor informado não aparece como ajuste
  ajustada(l: LinhaPrevista, m: number): boolean { return l.tipo !== 'investimento' && l.ajuste[m] !== null && l.ajuste[m] !== l.previsto[m]; }

  get metaDividas(): number { return this.linhasDividas.reduce((t, l) => t + l.meta, 0); }
  totalDividasMes(m: number): number { return this.linhasDividas.reduce((t, l) => t + this.valorLinha(l, m), 0); }
  get metaInvestimento(): number { return this.linhaInvestimento?.meta ?? 0; }
  totalInvestimentoMes(m: number): number { return this.linhaInvestimento ? this.valorLinha(this.linhaInvestimento, m) : 0; }

  // Saldo = receitas − gastos − dívidas − investimentos
  get saldoMeta(): number { return this.receitaMeta - this.metaMensal - this.metaDividas - this.metaInvestimento; }
  saldoMes(m: number): number {
    return this.receitasMes[m] - this.totalMes(m) - this.totalDividasMes(m) - this.totalInvestimentoMes(m);
  }
  statusSaldo(v: number): Status { return v > 0 ? 'ok' : v < 0 ? 'estourou' : 'vazio'; }

  alternarMacro(id: string) { this.macrosAbertos.has(id) ? this.macrosAbertos.delete(id) : this.macrosAbertos.add(id); }

  // Dívida abre a tela Dívidas já na aba do passivo (financeiro ou imobilizado).
  irParaMeta(l: LinhaPrevista) {
    if (!l.destino) return;
    this.router.navigate([l.destino], l.guia ? { queryParams: { guia: l.guia } } : {});
  }

  dicaLinha(l: LinhaPrevista, m: number): string {
    const v = this.valorLinha(l, m);
    if (l.tipo === 'investimento') return `${v ? 'Investido: ' + this.moeda(v) : 'Nada informado'} — clique para informar quanto investiu`;
    const base = this.ajustada(l, m) ? `Ajustado: ${this.moeda(v)} (previsto ${this.moeda(l.previsto[m])})` : `Previsto: ${this.moeda(v)}`;
    return `${base} — clique para ajustar este mês`;
  }

  // Ajuste de um mês (clique na célula)
  editandoCel: { linha: LinhaPrevista; mes: number } | null = null;
  valorCelEditando: number | null = null;
  erroCel = '';

  abrirEdicaoCel(l: LinhaPrevista, m: number) {
    if (this.editandoCel?.linha === l && this.editandoCel.mes === m) return;
    this.editandoCel = { linha: l, mes: m };
    this.valorCelEditando = this.valorLinha(l, m);
    this.erroCel = '';
    setTimeout(() => (document.querySelector<HTMLInputElement>('app-gestao-gastos .input-cel')?.select()));
  }
  cancelarEdicaoCel() { this.editandoCel = null; this.erroCel = ''; }

  salvarCel() {
    const e = this.editandoCel;
    if (!e) return;
    const { linha: l, mes: m } = e;
    const valor = this.valorCelEditando ?? 0;
    const anterior = l.ajuste[m];
    // Igual ao previsto: tira o ajuste (volta a acompanhar o previsto)
    const novo = valor === l.previsto[m] ? null : valor;
    this.editandoCel = null;
    if (novo === anterior) return;
    l.ajuste[m] = novo;
    this.service.salvarAjuste(l.tipo, l.refId, this.chaveColuna(m), novo).subscribe({
      next: () => this.mostrarAviso(`${l.nome} em ${this.rotuloMesAno(m)}: ${this.moeda(this.valorLinha(l, m))}${novo === null ? ' (previsto)' : ''}.`),
      error: () => { l.ajuste[m] = anterior; this.erroCel = 'Não foi possível salvar o ajuste.'; this.cdr.detectChanges(); },
    });
  }

  voltarAoPrevisto(l: LinhaPrevista, m: number) {
    this.valorCelEditando = l.previsto[m];
    this.salvarCel();
  }

  // Meta de "Outras Dívidas" (a única meta editável fora dos gastos)
  editandoMetaOutras = false;
  valorMetaOutras: number | null = null;

  abrirMetaOutras(l: LinhaPrevista) {
    if (l.tipo !== 'outras_dividas') { this.irParaMeta(l); return; }
    this.editandoMetaOutras = true;
    this.valorMetaOutras = l.meta;
    setTimeout(() => (document.querySelector<HTMLInputElement>('app-gestao-gastos .input-meta-outras')?.select()));
  }

  salvarMetaOutras(l: LinhaPrevista) {
    if (!this.editandoMetaOutras) return;
    this.editandoMetaOutras = false;
    const valor = this.valorMetaOutras ?? 0;
    if (valor === l.meta) return;
    const anterior = l.meta;
    l.meta = valor;
    l.previsto = l.previsto.map(() => valor);
    this.service.salvarMetaOutrasDividas(valor).subscribe({
      next: () => this.mostrarAviso(`Meta de Outras Dívidas atualizada para ${this.moeda(valor)} por mês.`),
      error: () => { l.meta = anterior; l.previsto = l.previsto.map(() => anterior); this.cdr.detectChanges(); },
    });
  }

  // ── Receitas lançadas (painel do mês) ──
  painelReceita: { mes: number } | null = null;
  receitasLista: LancamentoReceita[] = [];
  carregandoReceitas = false;
  novaReceita: { data: string; valor: number | null; descricao: string } = { data: '', valor: null, descricao: '' };
  erroReceita = '';
  salvandoReceita = false;

  abrirReceitas(m: number) {
    this.fecharPainel();
    this.mesFoco = m;
    this.painelReceita = { mes: m };
    const dia = this.colunas[m] === this.hojeIdx ? this.hoje.getDate() : 1;
    this.novaReceita = { data: `${this.chaveColuna(m)}-${this.dois(dia)}`, valor: null, descricao: '' };
    this.erroReceita = '';
    this.carregarReceitasMes();
  }

  private carregarReceitasMes() {
    if (!this.painelReceita) return;
    this.carregandoReceitas = true;
    this.service.listarReceitas(this.chaveColuna(this.painelReceita.mes)).subscribe({
      next: (l) => { this.receitasLista = l; this.carregandoReceitas = false; this.cdr.detectChanges(); },
      error: () => { this.carregandoReceitas = false; this.erroReceita = 'Não foi possível carregar as receitas.'; this.cdr.detectChanges(); },
    });
  }

  fecharReceitas() { this.painelReceita = null; this.receitasLista = []; }

  salvarReceita() {
    if (this.salvandoReceita) return;
    const r = this.novaReceita;
    if (!r.data) { this.erroReceita = 'Informe a data.'; return; }
    if (!r.valor || r.valor <= 0) { this.erroReceita = 'Informe um valor maior que zero.'; return; }
    this.salvandoReceita = true;
    this.erroReceita = '';
    this.service.criarReceita({ data: r.data, valor: r.valor, descricao: r.descricao }).subscribe({
      next: () => {
        this.salvandoReceita = false;
        this.mostrarAviso(`Receita de ${this.moeda(r.valor!)} lançada.`);
        this.novaReceita = { ...r, valor: null, descricao: '' };
        this.carregarReceitasMes();
        this.carregar(); // a receita pode cair em outro mês da grade
      },
      error: (e) => { this.salvandoReceita = false; this.erroReceita = e?.error?.erro || 'Não foi possível lançar a receita.'; this.cdr.detectChanges(); },
    });
  }

  excluirReceita(l: LancamentoReceita) {
    if (!l.id) return;
    this.service.excluirReceita(l.id).subscribe({
      next: () => { this.mostrarAviso('Receita excluída.'); this.carregarReceitasMes(); this.carregar(); },
      error: () => { this.erroReceita = 'Não foi possível excluir a receita.'; this.cdr.detectChanges(); },
    });
  }

  get totalReceitasPainel(): number { return this.receitasLista.reduce((t, l) => t + l.valor, 0); }

  // ── Mês de referência ──
  // O seletor do topo escolhe um mês: ele vira o foco dos cards de resumo e a grade rola até ele.
  // Se o mês está na visão do ano corrente (jan do ano até 12 meses à frente), mantém essa visão;
  // senão a grade passa a mostrar o ano daquele mês (jan–dez).
  seletorAberto = false;
  anoSeletor = this.hoje.getFullYear();

  get mesReferencia(): number { return this.colunas[this.mesFoco] ?? this.hojeIdx; }
  // "Out/2026": mês abreviado com 3 letras, como nas colunas da grade
  get rotuloReferencia(): string {
    const abs = this.mesReferencia;
    return `${MESES_ABREV[abs % 12]}/${Math.floor(abs / 12)}`;
  }

  irParaMes(abs: number) {
    const anoAtual = this.hoje.getFullYear();
    const anterior = this.hojeIdx - 1;
    const iniRolante = Math.floor(anterior / 12) * 12;
    const fimRolante = anterior + 12;
    const novoAno = abs >= iniRolante && abs <= fimRolante ? anoAtual : Math.floor(abs / 12);
    const trocaPeriodo = novoAno !== this.ano;
    if (trocaPeriodo) { this.ano = novoAno; this.definirPeriodo(); }
    this.mesFoco = this.colunaDe(abs);
    this.seletorAberto = false;
    this.fecharPainel();
    if (trocaPeriodo) { this.rolarAoCarregar = true; this.carregar(); }
    else { this.cdr.detectChanges(); this.rolarGradeParaMesAnterior(); }
  }

  passoMes(delta: number) { this.irParaMes(this.mesReferencia + delta); }
  irParaHoje() { this.irParaMes(this.hojeIdx); }

  abrirSeletor() {
    this.anoSeletor = Math.floor(this.mesReferencia / 12);
    this.seletorAberto = !this.seletorAberto;
  }
  get hojeIdxPublico(): number { return this.hojeIdx; }
  mesSeletorAbs(mes: number): number { return this.anoSeletor * 12 + mes; }

  abrirCelula(item: ItemLinha, mes: number) {
    this.painelReceita = null;
    this.celula = { item, mes };
    this.novoAberto = false;
    this.mesFoco = mes;
    this.erroLancamento = '';
    const dia = this.colunas[mes] === this.hojeIdx ? this.hoje.getDate() : 1;
    // Mesmo padrão do modal: "Mensal Comprometido" já abre com Recorrente/Parcelado ligado.
    const data = `${this.chaveColuna(mes)}-${this.dois(dia)}`;
    this.novo = { data, valor: null, descricao: '', repeticao: item.gasto.classe === 'Mensal Comprometido' ? repeticaoRecorrente(data) : repeticaoUnica() };
    this.carregarLancamentosCelula();
  }

  private cargaLancamentos?: Subscription;

  carregarLancamentosCelula() {
    if (!this.celula) return;
    const { item, mes } = this.celula;
    this.carregandoLancamentos = true;
    this.erroLancamentos = '';
    this.lancamentos = [];
    // Cancela a busca da célula anterior e não deixa o painel preso em "Carregando..." se o servidor não responder.
    this.cargaLancamentos?.unsubscribe();
    this.cargaLancamentos = this.service.listarLancamentos(item.gasto.id!, this.chaveColuna(mes)).pipe(timeout(8000)).subscribe({
      next: (lista) => { this.lancamentos = lista; this.carregandoLancamentos = false; this.cdr.detectChanges(); },
      error: (e) => {
        this.erroLancamentos = e?.status === 0 || e?.name === 'TimeoutError'
          ? 'O servidor não respondeu. Verifique se o backend está ligado e tente de novo.'
          : 'Não foi possível carregar os lançamentos.';
        this.carregandoLancamentos = false;
        this.cdr.detectChanges();
      },
    });
  }

  fecharPainel() { this.cargaLancamentos?.unsubscribe(); this.carregandoLancamentos = false; this.celula = null; this.editandoId = null; this.confirmandoExclusao = null; this.painelReceita = null; }

  salvarLancamento() {
    if (!this.celula) return;
    const prefixo = this.chaveColuna(this.celula.mes);
    if (!this.novo.data?.startsWith(prefixo)) { this.erroLancamento = `A data precisa estar em ${this.rotuloMesAno(this.celula.mes)}.`; return; }
    const plano = planejarLancamentos(this.novo.data, this.novo.valor, this.novo.repeticao);
    if (plano.erro) { this.erroLancamento = plano.erro; return; }
    this.erroLancamento = '';
    const { item } = this.celula;
    const descricao = this.novo.descricao.trim();
    const meses = plano.datas.length;
    // Mostra na hora; os ids definitivos chegam com a resposta do servidor.
    // A 1ª parcela entra na lista deste mês; as demais só somam na grade dos meses seguintes.
    const provisorios: LancamentoGasto[] = this.provisorios(plano, item.gasto.id!, descricao)
      .map((l) => ({ ...l, id: this.idProvisorio-- }));
    const [primeiro] = provisorios;
    this.lancamentos = [primeiro, ...this.lancamentos];
    provisorios.forEach((l) => this.aplicar(l, 1));
    if (meses > 1) this.mostrarAviso(this.avisoRepeticao(this.novo.repeticao, meses, item.nome));
    const corpo = this.corpoLancamento(item.gasto.id!, this.novo.data, this.novo.valor!, descricao, this.novo.repeticao, meses);
    this.novo = { ...this.novo, valor: null, descricao: '' };
    this.service.lancarRecorrente(corpo).subscribe({
      next: (criados) => {
        const real = (Array.isArray(criados) ? criados : [criados]).find((l) => l.data === primeiro.data) ?? null;
        this.lancamentos = real ? this.lancamentos.map((x) => (x.id === primeiro.id ? real : x)) : this.lancamentos;
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.lancamentos = this.lancamentos.filter((x) => x.id !== primeiro.id);
        provisorios.forEach((l) => this.aplicar(l, -1));
        this.avisoSucesso = '';
        this.erroLancamento = e?.error?.erro || 'Não foi possível salvar o lançamento.';
        this.cdr.detectChanges();
      },
    });
  }

  // Ids negativos marcam lançamentos ainda não confirmados pelo servidor.
  private idProvisorio = -1;

  // Exclusão: lançamentos de recorrência perguntam se apagam também os meses seguintes.
  confirmandoExclusao: LancamentoGasto | null = null;

  pedirExclusao(l: LancamentoGasto) {
    if (l.recorrencia_grupo) { this.confirmandoExclusao = l; return; }
    this.excluirLancamento(l, false);
  }

  excluirLancamento(l: LancamentoGasto, seguintes: boolean) {
    if (!l.id || l.id < 0) return;
    this.confirmandoExclusao = null;
    // Some da tela na hora; as parcelas seguintes (outros meses) saem quando o servidor responder.
    const posicao = this.lancamentos.indexOf(l);
    this.lancamentos = this.lancamentos.filter((x) => x.id !== l.id);
    this.aplicar(l, -1);
    this.service.excluirLancamento(l.id, seguintes).subscribe({
      next: (res) => {
        res.removidos.filter((r) => r.id !== l.id).forEach((r) => this.aplicar(r, -1));
        this.cdr.detectChanges();
      },
      error: () => {
        this.lancamentos = [...this.lancamentos.slice(0, posicao), l, ...this.lancamentos.slice(posicao)];
        this.aplicar(l, 1);
        this.erroLancamento = 'Não foi possível excluir o lançamento.';
        this.cdr.detectChanges();
      },
    });
  }

  // Edição inline no painel
  editandoId: number | null = null;
  edicao = { data: '', valor: null as number | null, descricao: '', gastoId: 0, itemSeguintes: true };
  erroEdicao = '';

  editar(l: LancamentoGasto) {
    if (l.id! < 0) return; // ainda salvando
    this.confirmandoExclusao = null;
    this.editandoId = l.id!;
    this.erroEdicao = '';
    this.edicao = { data: l.data, valor: l.valor, descricao: l.descricao || '', gastoId: l.gasto_id, itemSeguintes: true };
  }

  cancelarEdicao() { this.editandoId = null; }

  salvarEdicao(l: LancamentoGasto) {
    const valor = Number(this.edicao.valor);
    if (!valor || valor <= 0) { this.erroEdicao = 'Informe um valor maior que zero.'; return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.edicao.data || '')) { this.erroEdicao = 'Informe a data.'; return; }
    const anterior = [...this.lancamentos];
    const gastoId = Number(this.edicao.gastoId) || l.gasto_id;
    const trocouItem = gastoId !== l.gasto_id;
    const editado: LancamentoGasto = { ...l, data: this.edicao.data, valor, descricao: this.edicao.descricao.trim(), gasto_id: gastoId };
    const trocar = (novo: LancamentoGasto) => {
      const mesPainel = this.celula ? this.chaveColuna(this.celula.mes) : '';
      // Se a data mudou de mês ou o item mudou, o lançamento sai da lista desta célula.
      this.lancamentos = novo.data.startsWith(mesPainel) && novo.gasto_id === this.celula?.item.gasto.id
        ? anterior.map((x) => (x.id === novo.id ? novo : x))
        : anterior.filter((x) => x.id !== novo.id);
    };
    this.aplicar(l, -1);
    this.aplicar(editado, 1);
    trocar(editado);
    this.editandoId = null;
    const itemSeguintes = trocouItem && !!l.recorrencia_grupo && this.edicao.itemSeguintes;
    this.service.editarLancamento(l.id!, { data: editado.data, valor, descricao: editado.descricao, gasto_id: gastoId, item_seguintes: itemSeguintes }).subscribe({
      next: (novo) => {
        const { seguintes_movidos, ...lanc } = novo;
        // Parcelas seguintes que mudaram de item: saem do item antigo e entram no novo, na grade.
        (seguintes_movidos ?? []).forEach((m) => { this.aplicar({ ...m, gasto_id: m.gasto_anterior }, -1); this.aplicar(m, 1); });
        trocar(lanc);
        if (trocouItem) this.mostrarAviso(`Lançamento movido para "${this.nomeItem(gastoId)}"` +
          ((seguintes_movidos?.length ?? 0) ? `, com ${seguintes_movidos.length} ${seguintes_movidos.length === 1 ? 'parcela seguinte' : 'parcelas seguintes'}.` : '.'));
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.aplicar(editado, -1);
        this.aplicar(l, 1);
        this.lancamentos = anterior;
        this.editandoId = l.id!;
        this.erroEdicao = e?.error?.erro || 'Não foi possível salvar.';
        this.cdr.detectChanges();
      },
    });
  }

  // Soma (sinal 1) ou retira (sinal -1) um lançamento da grade, sem recarregar a página.
  private aplicar(l: LancamentoGasto, sinal: 1 | -1) {
    const mes = this.colunaDe(this.indiceMes(l.data));
    if (mes < 0 || mes >= this.colunas.length) return;
    for (const cat of this.categorias) {
      const item = cat.itens.find((i) => i.gasto.id === l.gasto_id);
      if (!item) continue;
      item.meses[mes] = Math.max(0, Math.round((item.meses[mes] + sinal * l.valor) * 100) / 100);
      cat.meses[mes] = cat.itens.reduce((s, i) => s + i.meses[mes], 0);
      return;
    }
  }

  get painelEventual(): boolean { return !!this.celula && this.eventual(this.celula.item); }
  get painelMeta(): number { return this.celula ? this.metaItemMes(this.celula.item, this.celula.mes) : 0; }
  get painelRealizado(): number {
    return this.celula && this.painelEventual ? this.realizadoItem(this.celula.item, this.celula.mes) : this.totalPainel;
  }

  // Enquanto a lista não carrega (ou se falhar), usa o total que a grade já conhece.
  get totalPainel(): number {
    if ((this.carregandoLancamentos || this.erroLancamentos) && this.celula) return this.celula.item.meses[this.celula.mes];
    return this.lancamentos.reduce((s, l) => s + l.valor, 0);
  }

  // ── Modal "Lançar gasto" ───────────────────────────────────
  get opcoesItens(): OpcaoItem[] {
    return this.categorias.flatMap((c) => c.itens.map((item) => ({ item, categoria: c.label })));
  }

  get sugestoes(): OpcaoItem[] {
    const termo = this.normalizar(this.busca);
    const todas = this.opcoesItens;
    if (!termo) return todas.slice(0, 8);
    return todas
      .filter((o) => this.normalizar(`${o.item.nome} ${o.categoria}`).includes(termo))
      .sort((a, b) => Number(!this.normalizar(a.item.nome).startsWith(termo)) - Number(!this.normalizar(b.item.nome).startsWith(termo)))
      .slice(0, 8);
  }

  abrirModal() {
    this.modalAberto = true;
    this.busca = '';
    this.itemModal = null;
    this.sugestoesAbertas = false;
    this.indiceSugestao = 0;
    this.erroModal = '';
    this.modal = { valor: null, data: this.hojeIso(), descricao: '', repeticao: repeticaoUnica() };
  }

  fecharModal() { this.modalAberto = false; }

  aoDigitarBusca(v: string) {
    this.busca = v;
    this.itemModal = null;
    this.sugestoesAbertas = true;
    this.indiceSugestao = 0;
  }

  teclaBusca(ev: KeyboardEvent) {
    const lista = this.sugestoes;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); this.sugestoesAbertas = true; this.indiceSugestao = Math.min(this.indiceSugestao + 1, lista.length - 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.indiceSugestao = Math.max(this.indiceSugestao - 1, 0); }
    else if (ev.key === 'Enter' && this.sugestoesAbertas && lista[this.indiceSugestao]) { ev.preventDefault(); this.escolherItem(lista[this.indiceSugestao]); }
    else if (ev.key === 'Escape' && this.sugestoesAbertas) { ev.stopPropagation(); this.sugestoesAbertas = false; }
  }

  escolherItem(o: OpcaoItem) {
    this.itemModal = o;
    this.busca = o.item.nome;
    this.sugestoesAbertas = false;
    this.erroModal = '';
    // Gastos "Mensal Comprometido" se repetem todo mês: a recorrência já vem ligada (12 meses).
    this.modal.repeticao = o.item.gasto.classe === 'Mensal Comprometido' ? repeticaoRecorrente(this.modal.data) : repeticaoUnica();
    if (!this.modal.valor && o.item.meta) this.modal.valor = o.item.meta;
  }

  fecharSugestoesDepois() { setTimeout(() => { this.sugestoesAbertas = false; this.cdr.detectChanges(); }, 150); }

  // Corpo do POST: na recorrência, `meses` lançamentos de `valor`; no parcelado, `valor` é o total dividido.
  private corpoLancamento(gastoId: number, data: string, valor: number, descricao: string, r: Repeticao, meses: number): LancamentoGasto {
    return { gasto_id: gastoId, data, valor: Number(valor), descricao, origem: 'manual', meses, dividir: r.modo === 'parcelado' && meses > 1 };
  }

  private provisorios(plano: PlanoLancamento, gastoId: number, descricao: string): LancamentoGasto[] {
    const n = plano.datas.length;
    return plano.datas.map((data, i) => ({
      gasto_id: gastoId, data, valor: plano.valores[i], descricao, origem: 'manual',
      ...(n > 1 ? { recorrencia_grupo: 'provisorio', parcela: i + 1, total_parcelas: n } : {}),
    }));
  }

  private avisoRepeticao(r: Repeticao, n: number, nome: string): string {
    return r.modo === 'parcelado' ? `${n} parcelas de "${nome}" lançadas.` : `${n} lançamentos mensais de "${nome}" criados.`;
  }

  rotuloLancar(r: Repeticao, data: string, valor: number | null): string {
    const n = planejarLancamentos(data, valor, r).datas.length;
    if (n <= 1) return 'Lançar gasto';
    return r.modo === 'parcelado' ? `Lançar ${n} parcelas` : `Lançar ${n} meses`;
  }

  salvarModal() {
    if (!this.itemModal) { this.erroModal = 'Escolha um item da lista.'; return; }
    const plano = planejarLancamentos(this.modal.data, this.modal.valor, this.modal.repeticao);
    if (plano.erro) { this.erroModal = plano.erro; return; }
    const meses = plano.datas.length;

    this.erroModal = '';
    const nome = this.itemModal.item.nome;
    const gastoId = this.itemModal.item.gasto.id!;
    // Fecha e mostra na grade na hora; se o servidor recusar, desfaz e reabre o modal com o erro.
    const provisorios = this.provisorios(plano, gastoId, '');
    provisorios.forEach((l) => this.aplicar(l, 1));
    const rascunho = { busca: this.busca, item: this.itemModal, modal: { ...this.modal } };
    this.modalAberto = false;
    this.mostrarAviso(meses > 1 ? this.avisoRepeticao(this.modal.repeticao, meses, nome) : `Gasto em "${nome}" lançado.`);
    this.service.lancarRecorrente(
      this.corpoLancamento(gastoId, this.modal.data, this.modal.valor!, this.modal.descricao, this.modal.repeticao, meses),
    ).subscribe({
      error: (e) => {
        provisorios.forEach((l) => this.aplicar(l, -1));
        this.avisoSucesso = '';
        this.busca = rascunho.busca;
        this.itemModal = rascunho.item;
        this.modal = rascunho.modal;
        this.erroModal = e?.error?.erro || 'Não foi possível salvar. Tente de novo.';
        this.modalAberto = true;
        this.cdr.detectChanges();
      },
    });
  }

  private avisoTimer: ReturnType<typeof setTimeout> | undefined;

  private mostrarAviso(texto: string) {
    this.avisoSucesso = texto;
    clearTimeout(this.avisoTimer);
    this.avisoTimer = setTimeout(() => { this.avisoSucesso = ''; this.cdr.detectChanges(); }, 4000);
  }

  private normalizar(t: string): string {
    return (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  private hojeIso(): string {
    return `${this.hoje.getFullYear()}-${this.dois(this.hoje.getMonth() + 1)}-${this.dois(this.hoje.getDate())}`;
  }

  // ── Gastos em suspenso ─────────────────────────────────────
  suspensos: GastoSuspenso[] = [];
  quadroSuspensosAberto = false;
  carregandoSuspensos = false;
  ocupadoSuspensoId: number | null = null;
  alterados = new Set<number>();
  erroSuspenso: Record<number, string> = {};
  mensagemTeste = '';
  enviandoMensagem = false;
  retornoMensagem = '';

  carregarSuspensos() {
    this.carregandoSuspensos = true;
    this.service.listarSuspensos().subscribe({
      next: (lista) => { this.suspensos = lista; this.alterados.clear(); this.carregandoSuspensos = false; this.cdr.detectChanges(); },
      error: () => { this.carregandoSuspensos = false; this.cdr.detectChanges(); },
    });
  }

  // ── Visão dos Parcelados ──
  // Todas as parcelas de compras parceladas, somadas por mês, para ver quanto do orçamento já está
  // comprometido ao longo do tempo. Por padrão começa no mês atual; os meses passados ficam opcionais.
  menuFerramentasAberto = false;
  parcelados: {
    carregando: boolean;
    erro: string;
    meses: MesParcelado[];
    mostrarPassados: boolean;
    abertos: Set<number>;
  } | null = null;

  abrirParcelados() {
    this.parcelados = { carregando: true, erro: '', meses: [], mostrarPassados: false, abertos: new Set<number>() };
    this.service.listarParcelados().subscribe({
      next: (rows) => {
        if (!this.parcelados) return;
        this.parcelados.meses = this.agruparParcelados(rows);
        this.parcelados.carregando = false;
        this.cdr.detectChanges();
      },
      error: () => {
        if (!this.parcelados) return;
        this.parcelados.erro = 'Não foi possível carregar os parcelados.';
        this.parcelados.carregando = false;
        this.cdr.detectChanges();
      },
    });
  }
  fecharParcelados() { this.parcelados = null; }

  private agruparParcelados(rows: ParcelaGasto[]): MesParcelado[] {
    if (!rows.length) return [];
    const porMes = new Map<number, ParcelaMes[]>();
    for (const r of rows) {
      const [a, m] = r.data.slice(0, 7).split('-').map(Number);
      const idx = a * 12 + m - 1;
      const lista = porMes.get(idx) ?? [];
      lista.push({
        id: r.id!, descricao: r.descricao?.trim() || r.item?.trim() || 'Sem descrição',
        item: r.item?.trim() || 'Item sem nome',
        categoria: this.defsCategorias.find((d) => d.id === r.categoria)?.label ?? r.categoria ?? '',
        parcela: r.parcela ?? null, total_parcelas: r.total_parcelas ?? null, valor: r.valor || 0,
        ultima: !!r.parcela && r.parcela === r.total_parcelas,
      });
      porMes.set(idx, lista);
    }
    // Do primeiro ao último mês com parcela, sem buracos (meses vazios aparecem com R$ 0)
    const idxs = [...porMes.keys()];
    const meses: MesParcelado[] = [];
    for (let i = Math.min(...idxs); i <= Math.max(...idxs); i++) {
      const itens = (porMes.get(i) ?? []).sort((x, y) => y.valor - x.valor);
      meses.push({
        idx: i,
        rotulo: `${MESES_NOME[i % 12]} de ${Math.floor(i / 12)}`,
        total: itens.reduce((t, p) => t + p.valor, 0),
        itens,
        terminam: itens.filter((p) => p.ultima).length,
      });
    }
    return meses;
  }

  get mesesParceladosVisiveis(): MesParcelado[] {
    const p = this.parcelados;
    if (!p) return [];
    return p.mostrarPassados ? p.meses : p.meses.filter((m) => m.idx >= this.hojeIdx);
  }
  get maiorMesParcelado(): number { return Math.max(1, ...this.mesesParceladosVisiveis.map((m) => m.total)); }
  // Resumo: o que ainda vai ser pago a partir deste mês
  get parceladoAPagar(): number {
    return (this.parcelados?.meses ?? []).filter((m) => m.idx >= this.hojeIdx).reduce((t, m) => t + m.total, 0);
  }
  get parceladoMesAtual(): number { return this.parcelados?.meses.find((m) => m.idx === this.hojeIdx)?.total ?? 0; }
  get ultimoMesParcelado(): string {
    const m = this.parcelados?.meses;
    return m?.length && m[m.length - 1].idx >= this.hojeIdx ? m[m.length - 1].rotulo : '—';
  }
  get temParceladosPassados(): boolean { return !!this.parcelados?.meses.some((m) => m.idx < this.hojeIdx); }
  ehMesAtual(m: MesParcelado): boolean { return m.idx === this.hojeIdx; }
  alternarMesParcelado(m: MesParcelado) {
    const a = this.parcelados?.abertos;
    if (!a) return;
    a.has(m.idx) ? a.delete(m.idx) : a.add(m.idx);
  }

  abrirSuspensos() {
    this.quadroSuspensosAberto = true;
    this.retornoMensagem = '';
    this.carregarSuspensos();
  }

  fecharSuspensos() { this.quadroSuspensosAberto = false; }

  marcarAlterado(s: GastoSuspenso) { this.alterados.add(s.id); delete this.erroSuspenso[s.id]; }

  nomeItem(id: number | null): string {
    const o = this.opcoesItens.find((x) => x.item.gasto.id === id);
    return o ? `${o.categoria} › ${o.item.nome}` : '';
  }

  salvarSuspenso(s: GastoSuspenso) {
    this.ocupadoSuspensoId = s.id;
    this.service.salvarSuspenso(s).subscribe({
      next: (novo) => {
        this.suspensos = this.suspensos.map((x) => (x.id === novo.id ? novo : x));
        this.alterados.delete(s.id);
        this.ocupadoSuspensoId = null;
        this.cdr.detectChanges();
      },
      error: (e) => this.falhaSuspenso(s, e),
    });
  }

  confirmarSuspenso(s: GastoSuspenso) {
    if (!s.gasto_sugerido_id) { this.erroSuspenso[s.id] = 'Escolha o item.'; return; }
    if (!s.valor || s.valor <= 0) { this.erroSuspenso[s.id] = 'Informe o valor.'; return; }
    if (!s.data) { this.erroSuspenso[s.id] = 'Informe a data.'; return; }
    // Parcela x de y vinda de fatura: confirmar lança da x até a y.
    const gastoId = s.gasto_sugerido_id, valor = s.valor;
    const provisorios: LancamentoGasto[] = datasMensais(s.data!, this.parcelasRestantes(s))
      .map((data) => ({ gasto_id: gastoId, data, valor, descricao: s.descricao }));
    const anterior = this.suspensos;
    this.suspensos = this.suspensos.filter((x) => x.id !== s.id);
    provisorios.forEach((l) => this.aplicar(l, 1));
    this.service.confirmarSuspenso(s).subscribe({
      next: () => this.oferecerLote(s, gastoId),
      error: (e) => {
        provisorios.forEach((l) => this.aplicar(l, -1));
        this.suspensos = anterior;
        this.falhaSuspenso(s, e);
      },
    });
  }

  excluirSuspenso(s: GastoSuspenso) {
    const anterior = this.suspensos;
    this.suspensos = this.suspensos.filter((x) => x.id !== s.id);
    this.service.excluirSuspenso(s.id).subscribe({
      error: (e) => { this.suspensos = anterior; this.falhaSuspenso(s, e); },
    });
  }

  private falhaSuspenso(s: GastoSuspenso, e: any) {
    this.erroSuspenso[s.id] = e?.status === 0
      ? 'Sem conexão com o servidor. Verifique se o backend está ligado e tente de novo.'
      : e?.error?.erro || 'Não foi possível concluir.';
    this.ocupadoSuspensoId = null;
    this.cdr.detectChanges();
  }

  parcelasRestantes(s: GastoSuspenso): number {
    return s.parcela && s.total_parcelas && s.total_parcelas > 1 ? s.total_parcelas - s.parcela + 1 : 1;
  }

  // ── Criar item a partir de um gasto em suspenso ──
  readonly classesGasto = CLASSES_GASTO;
  novoItemPara: number | null = null; // id do suspenso com o formulário aberto
  novoItem = { categoria: '', nome: '', classe: 'Mensal Flexível' };
  erroNovoItem = '';
  criandoItem = false;

  abrirNovoItem(s: GastoSuspenso) {
    this.novoItemPara = s.id;
    this.erroNovoItem = '';
    this.novoItem = { categoria: '', nome: '', classe: 'Mensal Flexível' };
  }

  cancelarNovoItem() { this.novoItemPara = null; }

  criarItem(s: GastoSuspenso) {
    const nome = this.novoItem.nome.trim();
    if (!this.novoItem.categoria) { this.erroNovoItem = 'Escolha a categoria.'; return; }
    if (!nome) { this.erroNovoItem = 'Dê um nome ao item.'; return; }
    this.erroNovoItem = '';
    const selecionar = (g: Gasto) => {
      // Entra na grade e nas listas de itens sem recarregar a página (se ainda não estiver lá).
      const cat = this.categorias.find((c) => c.id === g.categoria);
      const linha: ItemLinha = { gasto: g, nome: g.descricao, meta: g.valor_mensal ?? 0, meses: Array(this.colunas.length).fill(0) };
      if (cat) {
        if (!cat.itens.some((i) => i.gasto.id === g.id)) cat.itens.push(linha);
      } else {
        const def = this.defsCategorias.find((d) => d.id === g.categoria)!;
        const nova = { id: def.id, label: def.label, itens: [linha], meta: 0, meses: Array(this.colunas.length).fill(0) };
        const ordem = this.defsCategorias.map((d) => d.id);
        this.categorias = [...this.categorias, nova].sort((a, b) => ordem.indexOf(a.id) - ordem.indexOf(b.id));
      }
      s.gasto_sugerido_id = g.id!;
      this.marcarAlterado(s);
      this.criandoItem = false;
      this.novoItemPara = null;
      // Salvou o item novo: o gasto já é lançado nele, sem precisar confirmar.
      this.confirmarSuspenso(s);
      this.cdr.detectChanges();
    };
    // Já existe com esse nome na categoria: só seleciona, sem criar outro.
    const repetido = this.categorias.find((c) => c.id === this.novoItem.categoria)?.itens
      .find((i) => this.normalizar(i.nome) === this.normalizar(nome));
    if (repetido) { selecionar(repetido.gasto); return; }
    this.criandoItem = true;
    this.gastoService.criar({
      categoria: this.novoItem.categoria, descricao: nome, classe: this.novoItem.classe, valor: 0, com_cartao: s.origem === 'fatura',
    }).pipe(timeout(10000)).subscribe({
      next: selecionar,
      error: (e) => {
        if (e?.status === 409 && e.error?.gasto) { selecionar(e.error.gasto); return; } // já existia: usa o mesmo
        this.criandoItem = false;
        this.erroNovoItem = e?.name === 'TimeoutError' || e?.status === 0
          ? 'O servidor não respondeu. Verifique se o backend está ligado e tente de novo.'
          : e?.error?.erro || 'Não foi possível criar o item.';
        this.cdr.detectChanges();
      },
    });
  }

  // ── Lançar todos do mesmo fornecedor ──
  // Depois de lançar um suspenso, oferece lançar no mesmo item os outros com a mesma descrição.
  // Os que têm aviso (ex.: possível repetido) ficam de fora, para o usuário conferir um a um.
  lote: { item: string; categoria: string; gastoId: number; outros: GastoSuspenso[]; comAviso: number } | null = null;
  // Compras marcadas no modal (todas por padrão); as desmarcadas continuam em suspenso.
  selecionadosLote = new Set<number>();
  lancandoLote = false;
  erroLote = '';

  private chaveFornecedor(s: GastoSuspenso): string {
    return this.normalizar(s.descricao || s.texto_original).replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private oferecerLote(base: GastoSuspenso, gastoId: number) {
    const chave = this.chaveFornecedor(base);
    if (!chave) return;
    const mesmos = this.suspensos.filter((x) => x.id !== base.id && this.chaveFornecedor(x) === chave);
    const outros = mesmos.filter((x) => !x.aviso);
    if (!outros.length) return;
    const opcao = this.opcoesItens.find((o) => o.item.gasto.id === gastoId);
    this.lote = {
      item: opcao?.item.nome ?? 'item escolhido', categoria: opcao?.categoria ?? '', gastoId, outros,
      comAviso: mesmos.length - outros.length,
    };
    this.selecionadosLote = new Set(outros.map((s) => s.id));
    this.erroLote = '';
    this.cdr.detectChanges();
  }

  get marcadosLote(): GastoSuspenso[] { return (this.lote?.outros ?? []).filter((s) => this.selecionadosLote.has(s.id)); }
  get totalLote(): number { return this.marcadosLote.reduce((t, s) => t + (s.valor || 0), 0); }
  get todosMarcadosLote(): boolean { return !!this.lote && this.marcadosLote.length === this.lote.outros.length; }

  marcarLote(s: GastoSuspenso, marcado: boolean) {
    marcado ? this.selecionadosLote.add(s.id) : this.selecionadosLote.delete(s.id);
    this.erroLote = '';
  }

  marcarTodosLote(marcado: boolean) {
    this.selecionadosLote = new Set(marcado ? (this.lote?.outros ?? []).map((s) => s.id) : []);
  }

  recusarLote() { if (!this.lancandoLote) this.lote = null; }

  confirmarLote() {
    const lote = this.lote;
    if (!lote || this.lancandoLote) return;
    const marcados = this.marcadosLote;
    if (!marcados.length) { this.erroLote = 'Marque pelo menos um lançamento, ou clique em "Não, só este".'; return; }
    const validos = marcados.filter((s) => s.valor && s.valor > 0 && s.data);
    // Some da lista e entra na grade na hora; o que o servidor recusar volta para a lista.
    const provisorios = new Map(validos.map((s) => [s.id,
      datasMensais(s.data!, this.parcelasRestantes(s)).map((data) => ({ gasto_id: lote.gastoId, data, valor: s.valor!, descricao: s.descricao } as LancamentoGasto)),
    ]));
    const anterior = this.suspensos;
    this.lancandoLote = true;
    this.suspensos = this.suspensos.filter((x) => !provisorios.has(x.id));
    provisorios.forEach((ls) => ls.forEach((l) => this.aplicar(l, 1)));
    this.service.confirmarLote(lote.gastoId, validos).pipe(timeout(20000)).subscribe({
      next: (r) => {
        r.falhas.forEach((f) => {
          provisorios.get(f.id)?.forEach((l) => this.aplicar(l, -1));
          const s = anterior.find((x) => x.id === f.id);
          if (s) { this.suspensos = [s, ...this.suspensos]; this.erroSuspenso[s.id] = f.erro; }
        });
        const sem = marcados.length - validos.length;
        this.mostrarAviso(`${r.lancados.length + 1} lançamentos de "${lote.item}" feitos.` +
          (r.falhas.length + sem ? ` ${r.falhas.length + sem} ficaram em suspenso para revisar.` : ''));
        this.lancandoLote = false;
        this.lote = null;
        this.cdr.detectChanges();
      },
      error: (e) => {
        provisorios.forEach((ls) => ls.forEach((l) => this.aplicar(l, -1)));
        this.suspensos = anterior;
        this.lancandoLote = false;
        this.erroLote = e?.status === 0 || e?.name === 'TimeoutError'
          ? 'Sem conexão com o servidor. Verifique se o backend está ligado e tente de novo.'
          : e?.error?.erro || 'Não foi possível lançar todos.';
        this.cdr.detectChanges();
      },
    });
  }

  rotuloOrigem(s: GastoSuspenso): string {
    return s.origem === 'whatsapp' ? 'WhatsApp' : s.origem === 'fatura' ? 'Fatura' : 'Manual';
  }

  // ── Importar fatura do cartão ──────────────────────────────
  importacaoAberta = false;
  arquivoFatura: File | null = null;
  importando = false;
  erroImportacao = '';
  resumoImportacao: ResumoImportacao | null = null;
  private readonly limiteFaturaMb = 15;

  abrirImportacao() {
    this.importacaoAberta = true;
    this.arquivoFatura = null;
    this.erroImportacao = '';
    this.resumoImportacao = null;
  }

  fecharImportacao() {
    if (this.importando) return;
    this.importacaoAberta = false;
  }

  escolherArquivo(ev: Event) {
    const input = ev.target as HTMLInputElement;
    this.faturaLida = null;
    const arquivo = input.files?.[0] ?? null;
    this.erroImportacao = '';
    this.resumoImportacao = null;
    if (arquivo && arquivo.size > this.limiteFaturaMb * 1024 * 1024) {
      this.erroImportacao = `O arquivo passa de ${this.limiteFaturaMb} MB.`;
      this.arquivoFatura = null;
      input.value = '';
      return;
    }
    this.arquivoFatura = arquivo;
  }

  importarFatura() {
    const arquivo = this.arquivoFatura;
    if (!arquivo || this.importando) return;
    this.importando = true;
    this.erroImportacao = '';
    const leitor = new FileReader();
    leitor.onerror = () => { this.importando = false; this.erroImportacao = 'Não foi possível ler o arquivo.'; this.cdr.detectChanges(); };
    leitor.onload = () => {
      this.faturaLida = { nome: arquivo.name, base64: String(leitor.result).split(',')[1] ?? '' }; // tira o prefixo "data:...;base64,"
      this.enviarFatura();
    };
    leitor.readAsDataURL(arquivo);
  }

  private enviarFatura(senha?: string) {
    if (!this.faturaLida) return;
    this.importando = true;
    this.service.importarFatura(this.faturaLida.nome, this.faturaLida.base64, senha).subscribe({
      next: (r) => {
        this.resumoImportacao = r;
        this.importando = false;
        this.fecharPedidoSenha();
        this.faturaLida = null;
        this.carregar(); // lançamentos e parcelas podem cair em vários meses: recarrega a grade
        this.carregarSuspensos();
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.importando = false;
        const codigo = e?.error?.codigo;
        if (codigo === 'SENHA_NECESSARIA' || codigo === 'SENHA_INCORRETA') {
          this.pedindoSenha = true;
          this.senhaFatura = '';
          this.erroSenha = codigo === 'SENHA_INCORRETA' ? 'Senha incorreta. Confira e tente de novo.' : '';
        } else {
          this.fecharPedidoSenha();
          this.erroImportacao = e?.status === 0
            ? 'Sem conexão com o servidor. Verifique se o backend está ligado.'
            : e?.status === 413 ? `O arquivo é grande demais (limite de ${this.limiteFaturaMb} MB).`
            : e?.error?.erro || 'Não foi possível importar a fatura.';
        }
        this.cdr.detectChanges();
      },
    });
  }

  // ── Senha do PDF ──
  // A senha só vai para o servidor nesta requisição; não fica guardada no app.
  private faturaLida: { nome: string; base64: string } | null = null;
  pedindoSenha = false;
  senhaFatura = '';
  erroSenha = '';

  enviarSenha() {
    if (!this.senhaFatura || this.importando) return;
    this.erroSenha = '';
    this.enviarFatura(this.senhaFatura);
  }

  cancelarSenha() {
    if (this.importando) return;
    this.fecharPedidoSenha();
  }

  private fecharPedidoSenha() {
    this.pedindoSenha = false;
    this.senhaFatura = '';
    this.erroSenha = '';
  }

  revisarSuspensosDaImportacao() {
    this.importacaoAberta = false;
    this.abrirSuspensos();
  }

  // Simula a chegada de uma mensagem (ex.: WhatsApp) enquanto a integração não existe.
  enviarMensagemTeste() {
    const texto = this.mensagemTeste.trim();
    if (!texto || this.enviandoMensagem) return;
    this.enviandoMensagem = true;
    this.retornoMensagem = '';
    this.service.enviarMensagem(texto).subscribe({
      next: (r) => {
        if (r.resultado === 'lancado') {
          this.aplicar(r.lancamento, 1);
          this.retornoMensagem = `Identificado automaticamente: ${this.moeda(r.lancamento.valor)} em ${this.nomeItem(r.lancamento.gasto_id)}.`;
        } else {
          this.suspensos = [r.suspenso, ...this.suspensos];
          this.retornoMensagem = 'Não identificado com segurança — ficou em suspenso abaixo.';
        }
        this.mensagemTeste = '';
        this.enviandoMensagem = false;
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.retornoMensagem = e?.error?.erro || 'Não foi possível enviar.';
        this.enviandoMensagem = false;
        this.cdr.detectChanges();
      },
    });
  }

  // ── Formatação ──────────────────────────────────────────────
  moeda(v: number): string {
    return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  }

  // Mostra o texto completo ao passar o mouse só quando ele não coube e foi cortado com "…".
  dicaSeCortado(ev: MouseEvent, texto: string) {
    const el = ev.target as HTMLElement;
    el.title = el.scrollWidth > el.clientWidth ? texto : '';
  }

  moedaCentavos(v: number): string {
    return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  // Número sem o "R$", para as colunas no padrão contábil (símbolo à esquerda, valor à direita).
  numero(v: number): string {
    return (v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  compacto(v: number): string {
    if (!v) return '—';
    return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  dataCurta(iso: string): string {
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
  }

  // "outubro de 2026" — título do painel e mensagens.
  rotuloMesAno(m: number): string {
    const abs = this.colunas[m];
    return `${MESES_NOME[abs % 12]} de ${Math.floor(abs / 12)}`;
  }

  private dois(n: number): string { return String(n).padStart(2, '0'); }
}
