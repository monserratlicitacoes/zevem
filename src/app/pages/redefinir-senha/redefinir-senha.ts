import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

// Sem token na URL: pede o e-mail e envia o link. Com token (link do e-mail): cria a nova senha e entra.
@Component({
  selector: 'app-redefinir-senha',
  imports: [FormsModule, RouterLink],
  templateUrl: './redefinir-senha.html',
  styleUrl: '../login/login.scss',
})
export class RedefinirSenha implements OnInit {
  readonly ano = new Date().getFullYear();
  token = '';
  email = '';
  senha = '';
  senha2 = '';
  erro = '';
  enviado = '';
  carregando = false;

  constructor(private route: ActivatedRoute, private router: Router, private auth: AuthService, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    const q = this.route.snapshot.queryParamMap;
    this.token = q.get('token') || '';
    this.email = q.get('email') || '';
  }

  pedirLink() {
    if (!this.email.trim()) return;
    this.carregando = true;
    this.erro = '';
    this.auth.esqueciSenha(this.email.trim()).subscribe({
      next: (r) => { this.carregando = false; this.enviado = r.mensagem; this.cdr.detectChanges(); },
      error: (e) => { this.carregando = false; this.erro = this.mensagemErro(e); this.cdr.detectChanges(); },
    });
  }

  salvarSenha() {
    if (this.senha.length < 8) { this.erro = 'A senha deve ter no mínimo 8 caracteres.'; return; }
    if (this.senha !== this.senha2) { this.erro = 'As duas senhas não são iguais.'; return; }
    this.carregando = true;
    this.erro = '';
    this.auth.redefinirSenha(this.email, this.token, this.senha).subscribe({
      next: () => this.router.navigate(['/recebimentos']),
      error: (e) => { this.carregando = false; this.erro = this.mensagemErro(e); this.cdr.detectChanges(); },
    });
  }

  private mensagemErro(e: any): string {
    return e?.status === 0 ? 'Sem conexão com o servidor. Tente novamente em instantes.' : e?.error?.erro || 'Não foi possível concluir. Tente novamente.';
  }
}
