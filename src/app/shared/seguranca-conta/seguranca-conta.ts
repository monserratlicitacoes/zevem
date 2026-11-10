import { Component, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

// Configurações › Segurança da conta: trocar a senha, sair de todos os aparelhos e, pela LGPD,
// baixar os próprios dados ou excluir a conta
@Component({
  selector: 'app-seguranca-conta',
  imports: [FormsModule],
  templateUrl: './seguranca-conta.html',
  styleUrl: '../minha-assinatura/minha-assinatura.scss',
})
export class SegurancaConta {
  trocando = false;
  atual = '';
  nova = '';
  nova2 = '';
  erro = '';
  ok = '';
  salvando = false;

  constructor(private auth: AuthService, private cdr: ChangeDetectorRef) {}

  abrir() { this.trocando = true; this.erro = ''; this.ok = ''; }

  fechar() { this.trocando = false; this.atual = this.nova = this.nova2 = ''; this.erro = ''; }

  salvar() {
    if (this.nova.length < 8) { this.erro = 'A nova senha deve ter no mínimo 8 caracteres.'; return; }
    if (this.nova !== this.nova2) { this.erro = 'As duas senhas novas não são iguais.'; return; }
    this.salvando = true;
    this.erro = '';
    this.auth.trocarSenha(this.atual, this.nova).subscribe({
      next: () => { this.salvando = false; this.fechar(); this.ok = 'Senha trocada. Os outros aparelhos saíram da conta.'; this.cdr.detectChanges(); },
      error: (e) => { this.salvando = false; this.erro = e?.error?.erro || 'Não foi possível trocar a senha.'; this.cdr.detectChanges(); },
    });
  }

  excluindo = false;
  senhaExcluir = '';
  erroExcluir = '';

  baixarDados() {
    this.auth.baixarMeusDados().subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: 'zevem-meus-dados.json' });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: () => { this.erro = 'Não foi possível baixar seus dados agora.'; this.cdr.detectChanges(); },
    });
  }

  excluirConta() {
    if (!this.senhaExcluir) return;
    if (!confirm('Excluir sua conta e todos os seus dados? Isso não pode ser desfeito.')) return;
    this.erroExcluir = '';
    this.auth.excluirConta(this.senhaExcluir).subscribe({
      error: (e) => { this.erroExcluir = e?.error?.erro || 'Não foi possível excluir a conta.'; this.cdr.detectChanges(); },
    });
  }

  sairDeTodos() {
    if (!confirm('Sair da conta em todos os aparelhos, inclusive neste?')) return;
    this.auth.sairDeTodos().subscribe();
  }
}
