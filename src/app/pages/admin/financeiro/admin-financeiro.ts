import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
// KeyValuePipe volta para imports quando o bloco de pedidos de cancelamento for reativado
import { AdminService, ClienteFinanceiro, Cobranca, Financeiro, PedidoCancelamento, Plano } from '../../../services/admin.service';

const STATUS: Record<string, { rotulo: string; classe: string }> = {
  ativa: { rotulo: 'Em dia', classe: 'ok' },
  inadimplente: { rotulo: 'Inadimplente', classe: 'critico' },
  cancelada: { rotulo: 'Cancelada', classe: '' },
  encerrada: { rotulo: 'Encerrada', classe: '' },
  sem: { rotulo: 'Sem assinatura', classe: '' },
};
const STATUS_PARCELA: Record<string, { rotulo: string; classe: string }> = {
  pendente: { rotulo: 'A vencer', classe: '' }, paga: { rotulo: 'Paga', classe: 'ok' }, vencida: { rotulo: 'Vencida', classe: 'critico' },
  cancelada: { rotulo: 'Cancelada', classe: '' }, estornada: { rotulo: 'Estornada', classe: 'atencao' },
};

@Component({
  selector: 'app-admin-financeiro',
  imports: [FormsModule],
  templateUrl: './admin-financeiro.html',
  styleUrls: ['../admin-comum.scss', './admin-financeiro.scss'],
})
export class AdminFinanceiro implements OnInit {
  private service = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);

  readonly statusParcela = STATUS_PARCELA;
  carregando = true;
  erro = '';
  dados: Financeiro | null = null;
  planos: Plano[] = [];

  busca = '';
  filtroStatus = '';

  // Plano em edição (novo ou existente)
  plano: Plano | null = null;
  erroPlano = '';

  // Nova assinatura
  assinando: ClienteFinanceiro | null = null;
  planoEscolhido: number | null = null;
  inicio = new Date().toISOString().slice(0, 10);
  erroAssinar = '';

  // Parcelas abertas
  aberto: number | null = null; // assinatura_id
  parcelas: Cobranca[] = [];
  erroAcao = '';

  // Pedidos de cancelamento
  pedidos: PedidoCancelamento[] = [];
  motivos: Record<string, string> = {};
  verResolvidos = false;
  registrando = false;
  novoPedido = { usuario_id: null as number | null, motivo: 'outro', canal: 'whatsapp', detalhe: '' };
  erroPedido = '';
  readonly canais: Record<string, string> = { app: 'App', whatsapp: 'WhatsApp', atendimento: 'Atendimento' };
  readonly resolucoes: Record<string, string> = { cancelar_renovacao: 'Renovação cancelada', cancelar_agora: 'Cancelada na hora', revertido: 'Cliente ficou' };

  ngOnInit() {
    this.carregar();
    this.service.motivos().subscribe((m) => { this.motivos = m; this.cdr.detectChanges(); });
  }

  carregar() {
    this.service.financeiro().subscribe({
      next: (d) => { this.dados = d; this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.erro = 'Não foi possível carregar o financeiro.'; this.carregando = false; this.cdr.detectChanges(); },
    });
    this.service.planos().subscribe((p) => { this.planos = p; this.cdr.detectChanges(); });
    this.service.cancelamentos().subscribe((p) => { this.pedidos = p; this.cdr.detectChanges(); });
  }

  // ── Indicadores ──
  pct(v: number | null | undefined): string { return v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`; }
  nomeMes(m: string): string {
    const [a, n] = m.split('-').map(Number);
    return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][n - 1]}/${String(a).slice(2)}`;
  }

  // ── Pedidos de cancelamento ──
  get pedidosVisiveis(): PedidoCancelamento[] { return this.verResolvidos ? this.pedidos : this.pedidos.filter((p) => p.status === 'aberto'); }
  get abertos(): number { return this.pedidos.filter((p) => p.status === 'aberto').length; }
  get clientesComAssinatura(): ClienteFinanceiro[] {
    return (this.dados?.clientes ?? []).filter((c) => c.assinatura && (c.assinatura.status === 'ativa' || c.assinatura.status === 'inadimplente') && !c.pedido_cancelamento);
  }
  registrarPedido() {
    const n = this.novoPedido;
    if (!n.usuario_id) { this.erroPedido = 'Escolha o cliente.'; return; }
    this.service.registrarCancelamento(n.usuario_id, n.motivo, n.canal, n.detalhe).subscribe({
      next: () => { this.registrando = false; this.novoPedido = { usuario_id: null, motivo: 'outro', canal: 'whatsapp', detalhe: '' }; this.erroPedido = ''; this.carregar(); },
      error: (e) => { this.erroPedido = e?.error?.erro || 'Não foi possível registrar.'; this.cdr.detectChanges(); },
    });
  }
  resolver(p: PedidoCancelamento, acao: 'cancelar_renovacao' | 'cancelar_agora' | 'revertido') {
    const pergunta = acao === 'revertido' ? `Registrar que ${p.nome} decidiu ficar?`
      : acao === 'cancelar_agora' ? `Cancelar agora a assinatura de ${p.nome}? As parcelas em aberto serão canceladas.`
      : `Cancelar a renovação de ${p.nome}? A assinatura vale até ${this.data(p.fim_ciclo)}.`;
    if (!confirm(pergunta)) return;
    const obs = prompt('Observação (opcional):', '') ?? '';
    this.service.resolverCancelamento(p.id, acao, obs).subscribe({
      next: () => this.carregar(),
      error: (e) => alert(e?.error?.erro || 'Não foi possível resolver o pedido.'),
    });
  }

  get planosAtivos(): Plano[] { return this.planos.filter((p) => p.ativo); }

  status(c: ClienteFinanceiro) { return STATUS[c.assinatura?.status ?? 'sem']; }

  get filtrados(): ClienteFinanceiro[] {
    const termo = this.normalizar(this.busca);
    return (this.dados?.clientes ?? []).filter((c) => {
      if (termo && !this.normalizar(`${c.nome} ${c.email}`).includes(termo)) return false;
      if (this.filtroStatus && (c.assinatura?.status ?? 'sem') !== this.filtroStatus) return false;
      return true;
    }).sort((a, b) => this.peso(a) - this.peso(b) || a.nome.localeCompare(b.nome));
  }
  // Inadimplentes primeiro, depois em dia, depois o resto
  private peso(c: ClienteFinanceiro): number { return ({ inadimplente: 0, ativa: 1, cancelada: 2, encerrada: 3 } as Record<string, number>)[c.assinatura?.status ?? ''] ?? 4; }

  // ── Planos ──
  novoPlano() { this.plano = { nome: 'Anual', valor_anual: 0, parcelas: 12, ativo: true }; this.erroPlano = ''; }
  editarPlano(p: Plano) { this.plano = { ...p, ativo: !!p.ativo }; this.erroPlano = ''; }
  salvarPlano() {
    if (!this.plano) return;
    this.service.salvarPlano(this.plano).subscribe({
      next: () => { this.plano = null; this.carregar(); },
      error: (e) => { this.erroPlano = e?.error?.erro || 'Não foi possível salvar o plano.'; this.cdr.detectChanges(); },
    });
  }

  // ── Assinaturas ──
  abrirAssinar(c: ClienteFinanceiro) {
    this.assinando = c; this.erroAssinar = '';
    this.planoEscolhido = this.planosAtivos[0]?.id ?? null;
    this.inicio = new Date().toISOString().slice(0, 10);
  }
  confirmarAssinar() {
    if (!this.assinando || !this.planoEscolhido) return;
    this.service.criarAssinatura(this.assinando.usuario_id, this.planoEscolhido, this.inicio).subscribe({
      next: () => { this.assinando = null; this.carregar(); },
      error: (e) => { this.erroAssinar = e?.error?.erro || 'Não foi possível criar a assinatura.'; this.cdr.detectChanges(); },
    });
  }
  alternarRenovacao(c: ClienteFinanceiro) {
    const a = c.assinatura;
    if (!a) return;
    this.service.renovacao(a.id, !a.renovacao_automatica).subscribe(() => this.carregar());
  }
  cancelar(c: ClienteFinanceiro, imediato: boolean) {
    const a = c.assinatura;
    if (!a) return;
    const msg = imediato
      ? `Cancelar agora a assinatura de ${c.nome}? As parcelas em aberto serão canceladas.`
      : `Cancelar a renovação de ${c.nome}? A assinatura vale até ${this.data(a.fim_ciclo)} e as parcelas do ciclo continuam.`;
    if (!confirm(msg)) return;
    this.service.cancelar(a.id, imediato).subscribe(() => { this.aberto = null; this.carregar(); });
  }

  // ── Parcelas ──
  alternarParcelas(c: ClienteFinanceiro) {
    const id = c.assinatura?.id ?? null;
    if (this.aberto === id) { this.aberto = null; return; }
    this.aberto = id; this.parcelas = []; this.erroAcao = '';
    if (id) this.carregarParcelas(id);
  }
  private carregarParcelas(id: number) { this.service.cobrancas(id).subscribe((p) => { this.parcelas = p; this.cdr.detectChanges(); }); }
  get ciclosParcelas(): { ciclo: number; parcelas: Cobranca[] }[] {
    const m = new Map<number, Cobranca[]>();
    for (const p of this.parcelas) { if (!m.has(p.ciclo)) m.set(p.ciclo, []); m.get(p.ciclo)!.push(p); }
    return [...m].map(([ciclo, parcelas]) => ({ ciclo, parcelas }));
  }
  darBaixa(p: Cobranca) {
    const forma = prompt('Forma de pagamento (ex.: pix, cartão, boleto):', 'pix');
    if (forma === null) return;
    this.service.baixa(p.id, forma || 'manual', new Date().toISOString().slice(0, 10)).subscribe({
      next: () => { this.carregarParcelas(this.aberto!); this.carregar(); },
      error: (e) => { this.erroAcao = e?.error?.erro || 'Não foi possível dar baixa.'; this.cdr.detectChanges(); },
    });
  }
  desfazer(p: Cobranca) {
    if (!confirm(`Desfazer a baixa da parcela ${p.parcela}/${p.total_parcelas}?`)) return;
    this.service.desfazerBaixa(p.id).subscribe(() => { this.carregarParcelas(this.aberto!); this.carregar(); });
  }

  moeda(v: number | null | undefined): string {
    return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  data(iso: string | null | undefined): string { return iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—'; }
  private normalizar(t: string): string { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
}
