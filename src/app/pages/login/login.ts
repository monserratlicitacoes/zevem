import { Component, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  readonly ano = new Date().getFullYear();
  // Só no ambiente local (environment.semLogin): o botão entra sem e-mail e senha, pela rota de
  // desenvolvimento do backend (DEV_SEM_LOGIN=1, aceita só pedidos do próprio computador).
  // Em produção semLogin é false e o login continua exigindo e-mail e senha.
  readonly semLogin = environment.semLogin;
  email = '';
  senha = '';
  erro = '';
  carregando = false;

  constructor(private auth: AuthService, private router: Router, private cdr: ChangeDetectorRef) {}

  entrar() {
    if (this.semLogin) { this.entrarSemSenha(); return; }
    if (!this.email || !this.senha) return;
    this.carregando = true;
    this.erro = '';
    this.auth.login(this.email, this.senha).subscribe({
      next: () => {
        this.carregando = false;
        this.router.navigate(['/recebimentos']);
      },
      error: (e) => {
        this.carregando = false;
        this.erro = e.error?.erro === 'EMAIL_NAO_CONFIRMADO'
          ? (e.error?.mensagem || 'Confirme seu e-mail antes de entrar.')
          : e?.status === 0
            ? 'Sem conexão com o servidor. Tente novamente em instantes.'
            : e?.status === 429
              ? (e.error?.erro || 'Muitas tentativas. Aguarde alguns minutos.')
              : 'E-mail ou senha incorretos.';
        this.cdr.detectChanges();
      },
    });
  }

  private entrarSemSenha() {
    this.carregando = true;
    this.erro = '';
    this.auth.devLogin().subscribe({
      next: () => {
        this.carregando = false;
        this.router.navigate(['/recebimentos']);
      },
      error: (e) => {
        this.carregando = false;
        this.erro = e?.status === 0
          ? 'Sem conexão com o servidor. Verifique se o backend está ligado.'
          : 'Não foi possível entrar sem senha. Inicie o backend com DEV_SEM_LOGIN=1.';
        this.cdr.detectChanges();
      },
    });
  }
}
