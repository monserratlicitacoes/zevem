import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../services/auth.service';
import { AdminService, ClientePlanejador, Convite, PlanejadorAdmin } from '../../../services/admin.service';

const SITUACAO: Record<Convite['situacao'], { rotulo: string; classe: string }> = {
  pendente: { rotulo: 'Aguardando cadastro', classe: 'atencao' },
  aceito: { rotulo: 'Cadastrado', classe: 'ok' },
  expirado: { rotulo: 'Expirado', classe: '' },
  cancelado: { rotulo: 'Cancelado', classe: '' },
};

// Master: convida planejadores, vê os clientes de cada um e remove/devolve acessos
@Component({
  selector: 'app-admin-planejadores',
  imports: [FormsModule],
  templateUrl: './admin-planejadores.html',
  styleUrls: ['../admin-comum.scss', '../convites/admin-convites.scss', './admin-planejadores.scss'],
})
export class AdminPlanejadores implements OnInit {
  private service = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(AuthService);

  readonly situacao = SITUACAO;
  carregando = true;
  erro = '';
  planejadores: PlanejadorAdmin[] = [];
  convites: Convite[] = [];

  // Novo planejador
  form = { nome: '', email: '', cpf: '', telefone: '' };
  enviando = false;
  erroEnvio = '';
  enviado: Convite | null = null;
  copiado: number | null = null;

  // Clientes do planejador aberto
  aberto: number | null = null;
  clientes: ClientePlanejador[] = [];
  carregandoClientes = false;

  ngOnInit() { this.carregar(); }

  carregar() {
    let faltam = 2;
    const fim = () => { if (--faltam === 0) { this.carregando = false; this.cdr.detectChanges(); } };
    const falhou = () => { this.erro = 'Não foi possível carregar os planejadores.'; fim(); };
    this.service.planejadores().subscribe({ next: (p) => { this.planejadores = p; fim(); }, error: falhou });
    this.service.convitesPlanejador().subscribe({ next: (c) => { this.convites = c.filter((x) => x.situacao !== 'aceito'); fim(); }, error: falhou });
  }

  get ativos(): number { return this.planejadores.filter((p) => p.ativo).length; }
  get clientesAtivos(): number { return this.planejadores.reduce((t, p) => t + p.clientes_ativos, 0); }

  get formOk(): boolean {
    const f = this.form;
    return !!f.nome.trim() && !!f.email.trim() && f.cpf.replace(/\D/g, '').length === 11 && f.telefone.replace(/\D/g, '').length >= 10;
  }

  conviteAberto = false;

  abrirConvite() {
    this.enviado = null; this.erroEnvio = '';
    this.conviteAberto = true;
  }

  novoConvite() {
    this.enviado = null; this.erroEnvio = '';
  }

  fecharConvite() {
    if (this.enviando) return;
    this.conviteAberto = false;
    this.enviado = null; this.erroEnvio = '';
  }

  enviar() {
    if (!this.formOk || this.enviando) return;
    this.enviando = true; this.erroEnvio = ''; this.enviado = null;
    this.service.convidarPlanejador(this.form).subscribe({
      next: (c) => { this.enviando = false; this.enviado = c; this.form = { nome: '', email: '', cpf: '', telefone: '' }; this.carregar(); },
      error: (e) => { this.enviando = false; this.erroEnvio = e?.error?.erro || 'Não foi possível enviar o convite.'; this.cdr.detectChanges(); },
    });
  }

  reenviar(c: Convite) {
    this.service.reenviarConvite(c.id).subscribe({
      next: (r) => { this.enviado = r; this.conviteAberto = true; this.carregar(); },
      error: (e) => alert(e?.error?.erro || 'Não foi possível reenviar o convite.'),
    });
  }

  cancelarConvite(c: Convite) {
    if (!confirm(`Cancelar o convite de ${c.email}? O link deixa de funcionar.`)) return;
    this.service.cancelarConvite(c.id).subscribe({
      next: () => { if (this.enviado?.id === c.id) this.enviado = null; this.carregar(); },
      error: (e) => alert(e?.error?.erro || 'Não foi possível cancelar o convite.'),
    });
  }

  verClientes(p: PlanejadorAdmin) {
    if (this.aberto === p.id) { this.aberto = null; return; }
    this.aberto = p.id; this.clientes = []; this.carregandoClientes = true;
    this.service.clientesDoPlanejador(p.id).subscribe({
      next: (c) => { this.clientes = c; this.carregandoClientes = false; this.cdr.detectChanges(); },
      error: () => { this.carregandoClientes = false; this.cdr.detectChanges(); },
    });
  }

  removerPlanejador(p: PlanejadorAdmin) {
    if (!confirm(`Remover o acesso de ${p.nome}? Ele(a) não entra mais no Zevem e os convites em aberto deixam de valer. Os clientes dele(a) continuam com acesso.`)) return;
    this.service.removerAcesso(p.id).subscribe({ next: () => this.carregar(), error: (e) => alert(e?.error?.erro || 'Não foi possível remover o acesso.') });
  }

  devolverPlanejador(p: PlanejadorAdmin) {
    this.service.devolverAcesso(p.id).subscribe({ next: () => this.carregar(), error: (e) => alert(e?.error?.erro || 'Não foi possível devolver o acesso.') });
  }

  // Abre o Zevem do cliente (com edição); a faixa no topo leva de volta para cá
  acessar(c: ClientePlanejador) {
    this.service.acessarCliente(c.id).subscribe({
      next: (r) => this.auth.entrarNaContaDoCliente(r, '/admin/planejadores'),
      error: (e) => alert(e?.error?.erro || 'Não foi possível abrir a conta do cliente.'),
    });
  }

  alternarCliente(c: ClientePlanejador, p: PlanejadorAdmin) {
    if (c.ativo && !confirm(`Remover o acesso de ${c.nome}? Os dados ficam guardados e o acesso pode ser devolvido depois.`)) return;
    const req = c.ativo ? this.service.removerAcesso(c.id) : this.service.devolverAcesso(c.id);
    req.subscribe({
      next: () => { this.aberto = null; this.verClientes(p); this.carregar(); },
      error: (e) => alert(e?.error?.erro || 'Não foi possível alterar o acesso.'),
    });
  }

  async copiar(c: Convite) {
    if (!c.link) return;
    try { await navigator.clipboard.writeText(c.link); } catch { prompt('Copie o link do convite:', c.link); return; }
    this.copiado = c.id; this.cdr.detectChanges();
    setTimeout(() => { if (this.copiado === c.id) { this.copiado = null; this.cdr.detectChanges(); } }, 2000);
  }

  // Máscaras simples enquanto digita
  mascaraCpf(v: string): string {
    const d = v.replace(/\D/g, '').slice(0, 11);
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  mascaraTelefone(v: string): string {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return d.length <= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  data(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  diasDesde(iso: string | null): string {
    if (!iso) return 'nunca';
    const dias = Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 864e5);
    return dias <= 0 ? 'hoje' : dias === 1 ? 'ontem' : `há ${dias} dias`;
  }
}
