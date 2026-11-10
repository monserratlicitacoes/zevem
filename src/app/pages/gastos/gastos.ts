import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GastoService, Gasto, CLASSES_GASTO, CATEGORIA_NAO_IDENTIFICADO } from '../../services/gasto.service';
import { PessoaService, Pessoa } from '../../services/pessoa.service';
import { VideoBadge } from '../../shared/video-badge/video-badge';
import { JarroOrcamento } from '../../shared/jarro-orcamento/jarro-orcamento';
import { ClassificacaoGastos } from '../../shared/classificacao-gastos/classificacao-gastos';
import { AutoAltura } from '../../shared/auto-altura';

interface Aba {
  id: string;
  label: string;
}

@Component({
  selector: 'app-gastos',
  imports: [FormsModule, VideoBadge, ClassificacaoGastos, JarroOrcamento, AutoAltura],
  templateUrl: './gastos.html',
  styleUrl: './gastos.scss',
})
export class Gastos implements OnInit {
  jarroAberto = false; // modal "Jarro do Orçamento"
  classes = CLASSES_GASTO;
  pessoas: Pessoa[] = [];
  abas: Aba[] = [];
  abaAtiva = 'moradia';
  todosGastos: Gasto[] = [];
  gastos: Gasto[] = [];
  carregando = false;
  adicionando = false;
  linhasMinimas = 0;

  private readonly ABAS_FIXAS_INICIO: Aba[] = [
    { id: 'moradia',        label: 'Moradia' },
    { id: 'transporte',     label: 'Transporte' },
    { id: 'vida-saude',     label: 'Vida e Saúde' },
    { id: 'lazer-doacoes',  label: 'Lazer' },
    { id: 'alimentacao',    label: 'Alimentação FDC' },
    { id: 'assinaturas',    label: 'Assinaturas' },
  ];

  private readonly ABAS_FIXAS_FIM: Aba[] = [
    { id: 'dependentes', label: 'Dependentes' },
    { id: 'empresa',     label: 'Empresa' },
    // "Não Identificado" é uma categoria invisível aqui: só aparece nos relatórios.
  ];

  constructor(
    private gastoService: GastoService,
    private pessoaService: PessoaService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit() {
    this.construirAbas();
    this.carregarTodos();
    this.pessoaService.listar().subscribe({
      next: (lista) => {
        this.pessoas = lista;
        this.construirAbas();
        this.cdr.detectChanges();
      },
    });
  }

  construirAbas() {
    // Aba de pessoa: só para quem está cadastrado (ou se a categoria ainda tem itens). Ao excluir uma
    // pessoa em Configurações, a categoria dela some junto com os itens.
    const dinamicas: Aba[] = [];
    const [p1, p2] = this.pessoas;
    const temItens = (id: string) => this.todosGastos.some(g => g.categoria === id);
    if (p1 || temItens('pessoa-1')) dinamicas.push({ id: 'pessoa-1', label: p1 ? this.primeiroNome(p1.nome) : 'Adulto' });
    if (p2 || temItens('pessoa-2')) dinamicas.push({ id: 'pessoa-2', label: p2 ? this.primeiroNome(p2.nome) : 'Cônjuge' });
    this.abas = [...this.ABAS_FIXAS_INICIO, ...dinamicas, ...this.ABAS_FIXAS_FIM];
  }

  primeiroNome(nome: string): string {
    return nome.trim().split(/\s+/)[0];
  }

  carregarTodos() {
    this.carregando = true;
    this.gastoService.listar('').subscribe({
      next: (lista) => {
        // Linhas criadas por "Adicionar linha" e abandonadas sem preencher nada são descartadas
        lista.filter(g => this.linhaVazia(g)).forEach(g => this.gastoService.excluir(g.id!).subscribe());
        this.todosGastos = lista.filter(g => !this.linhaVazia(g));
        this.construirAbas();
        this.filtrarAba();
        this.carregando = false;
        this.cdr.detectChanges();
      },
      error: () => { this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  selecionarAba(id: string) {
    if (id === this.abaAtiva) return;
    this.abaAtiva = id;
    this.filtrarAba();
  }

  filtrarAba() {
    this.gastos = this.todosGastos.filter(g => g.categoria === this.abaAtiva);
  }

  totalAba(id: string): number {
    return this.todosGastos
      .filter(g => g.categoria === id)
      .reduce((s, g) => s + this.valorMensal(g), 0);
  }

  get linhasVazias(): number[] {
    const faltam = this.linhasMinimas - this.gastos.length;
    return faltam > 0 ? Array.from({ length: faltam }, (_, i) => i) : [];
  }

  valorMensal(g: Gasto): number {
    return g.valor_mensal ?? (g.classe?.startsWith('Eventual') ? Math.round((g.valor || 0) / 12) : (g.valor || 0));
  }

  get totalMensal(): number {
    return this.gastos.reduce((s, g) => s + this.valorMensal(g), 0);
  }

  get totalGeralMensal(): number {
    return this.todosGastos.reduce((s, g) => s + this.valorMensal(g), 0);
  }

  // ── Dashboard ──────────────────────────────────────────────
  modalAberto = false;
  fluxoAberto = false; // fluxograma da classificação dos gastos

  get dashPorClasse(): { label: string; valor: number }[] {
    return this.classes.map(c => ({
      label: c,
      valor: this.todosGastos
        .filter(g => g.classe === c)
        .reduce((s, g) => s + this.valorMensal(g), 0),
    }));
  }

  larguraBar(valor: number): string {
    const total = this.totalGeralMensal;
    return total > 0 ? `${Math.round((valor / total) * 100)}%` : '0%';
  }

  pct(valor: number): string {
    const total = this.totalGeralMensal;
    return total > 0 ? `${Math.round((valor / total) * 100)}%` : '0%';
  }

  adicionarLinha() {
    if (this.adicionando) return;
    this.adicionando = true;
    this.gastoService.criar({ categoria: this.abaAtiva, descricao: '', com_cartao: false, classe: '', valor: 0 }).subscribe({
      next: (g) => {
        this.todosGastos = [...this.todosGastos, g];
        this.filtrarAba();
        this.adicionando = false;
        this.cdr.detectChanges();
        // Já põe o cursor no item da linha nova: se a pessoa sair sem preencher, aoSairDaLinha a descarta
        const campos = document.querySelectorAll<HTMLInputElement>('.tr-data .input-desc');
        campos[campos.length - 1]?.focus();
      },
      error: () => { this.adicionando = false; this.cdr.detectChanges(); },
    });
  }

  // ── Vencimento ──
  // No cartão: vence com a fatura. Mensal Comprometido: dia do mês. Eventual Comprometido: mês do ano.
  // Classes flexíveis: sem data (campo desabilitado).
  readonly meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  tipoVencimento(g: Gasto): 'dia' | 'mes' | 'cartao' | 'sem' {
    if (g.com_cartao) return 'cartao';
    if (g.classe === 'Mensal Comprometido') return 'dia';
    if (g.classe === 'Eventual Comprometido') return 'mes';
    return 'sem';
  }

  // Dia do mês (1 a 31); fora disso ou vazio, fica sem data
  onDiaVencimentoBlur(e: Event, g: Gasto) {
    const input = e.target as HTMLInputElement;
    const n = parseInt(input.value.replace(/\D/g, '').slice(0, 2), 10);
    const dia = n >= 1 && n <= 31 ? n : null;
    input.value = dia ? String(dia) : '';
    if (dia === (g.dia_vencimento ?? null)) return;
    g.dia_vencimento = dia;
    this.salvarLinha(g);
  }

  onMesVencimentoChange(g: Gasto) {
    g.mes_vencimento = g.mes_vencimento ? Number(g.mes_vencimento) : null;
    this.salvarLinha(g);
  }

  salvarLinha(g: Gasto) {
    if (!g.id || g.categoria === CATEGORIA_NAO_IDENTIFICADO) return;
    this.gastoService.atualizar(g.id, g).subscribe({
      next: (atualizado) => {
        const i = this.gastos.findIndex(x => x.id === g.id);
        if (i >= 0) this.gastos[i] = atualizado;
        const j = this.todosGastos.findIndex(x => x.id === g.id);
        if (j >= 0) this.todosGastos[j] = atualizado;
        this.cdr.detectChanges();
      },
    });
  }

  // Sem item, valor, classificação nem cartão: a linha não tem nada a guardar
  linhaVazia(g: Gasto): boolean {
    return !!g.id && g.categoria !== CATEGORIA_NAO_IDENTIFICADO
      && !g.descricao?.trim() && !g.valor && !g.classe && !g.com_cartao;
  }

  // Ao sair de uma linha vazia (o foco foi para fora dela), a linha é excluída
  aoSairDaLinha(e: FocusEvent, g: Gasto) {
    const linha = e.currentTarget as HTMLElement;
    if (e.relatedTarget instanceof Node && linha.contains(e.relatedTarget)) return;
    if (this.linhaVazia(g)) this.excluirLinha(g);
  }

  excluirLinha(g: Gasto) {
    if (!g.id || g.categoria === CATEGORIA_NAO_IDENTIFICADO) return;
    this.gastoService.excluir(g.id).subscribe({
      next: () => {
        this.gastos = this.gastos.filter(x => x.id !== g.id);
        this.todosGastos = this.todosGastos.filter(x => x.id !== g.id);
        this.cdr.detectChanges();
      },
    });
  }

  formatarValor(v: number): string {
    return v ? Math.round(v).toLocaleString('pt-BR') : '';
  }

  onValorBlur(e: Event, g: Gasto) {
    const raw = (e.target as HTMLInputElement).value.replace(/[^\d,]/g, '').replace(',', '.');
    g.valor = raw ? Math.round(parseFloat(raw)) : 0;
    (e.target as HTMLInputElement).value = g.valor ? this.formatarValor(g.valor) : '';
    this.salvarLinha(g);
  }
}
