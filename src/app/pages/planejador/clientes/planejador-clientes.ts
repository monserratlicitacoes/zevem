import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../services/auth.service';
import { ClientePlanejador, Convite } from '../../../services/admin.service';
import { PlanejadorService } from '../../../services/planejador.service';

const SITUACAO: Record<Convite['situacao'], { rotulo: string; classe: string }> = {
  pendente: { rotulo: 'Aguardando cadastro', classe: 'atencao' },
  aceito: { rotulo: 'Cadastrado', classe: 'ok' },
  expirado: { rotulo: 'Expirado', classe: '' },
  cancelado: { rotulo: 'Cancelado', classe: '' },
};

// Área do planejador: convidar clientes, ver quem está ativo e remover (ou devolver) o acesso
@Component({
  selector: 'app-planejador-clientes',
  imports: [FormsModule],
  templateUrl: './planejador-clientes.html',
  styleUrls: ['../../admin/admin-comum.scss', '../../admin/convites/admin-convites.scss', './planejador-clientes.scss'],
})
export class PlanejadorClientes implements OnInit {
  private service = inject(PlanejadorService);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(AuthService);

  readonly situacao = SITUACAO;
  carregando = true;
  erro = '';
  clientes: ClientePlanejador[] = [];
  convites: Convite[] = [];
  busca = '';
  mostrarRemovidos = false;

  email = '';
  nome = '';
  enviando = false;
  erroEnvio = '';
  enviado: Convite | null = null;
  copiado: number | null = null;

  ngOnInit() { this.carregar(); }

  carregar() {
    let faltam = 2;
    const fim = () => { if (--faltam === 0) { this.carregando = false; this.cdr.detectChanges(); } };
    const falhou = () => { this.erro = 'Não foi possível carregar seus clientes.'; fim(); };
    this.service.clientes().subscribe({ next: (c) => { this.clientes = c; fim(); }, error: falhou });
    // Convites já aceitos viram clientes: aqui ficam só os que ainda não viraram conta
    this.service.convites().subscribe({ next: (c) => { this.convites = c.filter((x) => x.situacao !== 'aceito'); fim(); }, error: falhou });
  }

  get ativos(): number { return this.clientes.filter((c) => c.ativo).length; }
  get pendentes(): number { return this.convites.filter((c) => c.situacao === 'pendente').length; }
  get filtrados(): ClientePlanejador[] {
    const t = this.normalizar(this.busca);
    return this.clientes.filter((c) => (this.mostrarRemovidos || c.ativo) && (!t || this.normalizar(`${c.nome} ${c.email} ${c.telefone}`).includes(t)));
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
    if (!this.email.trim() || this.enviando) return;
    this.enviando = true; this.erroEnvio = ''; this.enviado = null;
    this.service.convidar(this.email, this.nome).subscribe({
      next: (c) => { this.enviando = false; this.enviado = c; this.email = ''; this.nome = ''; this.carregar(); },
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

  // Abre o Zevem do cliente (com edição); a faixa no topo traz de volta para "Meus clientes"
  acessar(c: ClientePlanejador) {
    this.service.acessarCliente(c.id).subscribe({
      next: (r) => this.auth.entrarNaContaDoCliente(r, '/planejador/clientes'),
      error: (e) => alert(e?.error?.erro || 'Não foi possível abrir a conta do cliente.'),
    });
  }

  removerAcesso(c: ClientePlanejador) {
    if (!confirm(`Remover o acesso de ${c.nome}? Ele(a) não consegue mais entrar no Zevem. Os dados ficam guardados e você pode devolver o acesso depois.`)) return;
    this.service.removerAcesso(c.id).subscribe({
      next: () => this.carregar(),
      error: (e) => alert(e?.error?.erro || 'Não foi possível remover o acesso.'),
    });
  }

  devolverAcesso(c: ClientePlanejador) {
    this.service.devolverAcesso(c.id).subscribe({
      next: () => this.carregar(),
      error: (e) => alert(e?.error?.erro || 'Não foi possível devolver o acesso.'),
    });
  }

  async copiar(c: Convite) {
    if (!c.link) return;
    try { await navigator.clipboard.writeText(c.link); } catch { prompt('Copie o link do convite:', c.link); return; }
    this.copiado = c.id; this.cdr.detectChanges();
    setTimeout(() => { if (this.copiado === c.id) { this.copiado = null; this.cdr.detectChanges(); } }, 2000);
  }

  // Datas do SQLite vêm em UTC ("AAAA-MM-DD HH:MM:SS")
  data(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  diasDesde(iso: string | null): string {
    if (!iso) return 'nunca';
    const dias = Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 864e5);
    return dias <= 0 ? 'hoje' : dias === 1 ? 'ontem' : `há ${dias} dias`;
  }
  private normalizar(t: string): string { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
}
