import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminService, Convite } from '../../../services/admin.service';

const SITUACAO: Record<Convite['situacao'], { rotulo: string; classe: string }> = {
  pendente: { rotulo: 'Aguardando cadastro', classe: 'atencao' },
  aceito: { rotulo: 'Cadastrado', classe: 'ok' },
  expirado: { rotulo: 'Expirado', classe: '' },
  cancelado: { rotulo: 'Cancelado', classe: '' },
};

@Component({
  selector: 'app-admin-convites',
  imports: [FormsModule],
  templateUrl: './admin-convites.html',
  styleUrls: ['../admin-comum.scss', './admin-convites.scss'],
})
export class AdminConvites implements OnInit {
  private service = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);

  readonly situacao = SITUACAO;
  carregando = true;
  erro = '';
  convites: Convite[] = [];

  email = '';
  nome = '';
  enviando = false;
  erroEnvio = '';
  enviado: Convite | null = null; // último convite criado (mostra o link para copiar)
  copiado: number | null = null;

  ngOnInit() { this.carregar(); }

  carregar() {
    this.service.convites().subscribe({
      next: (c) => { this.convites = c; this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.erro = 'Não foi possível carregar os convites.'; this.carregando = false; this.cdr.detectChanges(); },
    });
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
      next: (r) => { this.enviado = r; this.carregar(); },
      error: (e) => alert(e?.error?.erro || 'Não foi possível reenviar o convite.'),
    });
  }

  cancelar(c: Convite) {
    if (!confirm(`Cancelar o convite de ${c.email}? O link deixa de funcionar.`)) return;
    this.service.cancelarConvite(c.id).subscribe({
      next: () => { if (this.enviado?.id === c.id) this.enviado = null; this.carregar(); },
      error: (e) => alert(e?.error?.erro || 'Não foi possível cancelar o convite.'),
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
}
