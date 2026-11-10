import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-confirmar-email',
  imports: [RouterLink],
  templateUrl: './confirmar-email.html',
  styleUrls: ['../login/login.scss', './confirmar-email.scss'],
})
export class ConfirmarEmail implements OnInit {
  readonly ano = new Date().getFullYear();
  carregando = true;
  erro = '';
  jaConfirmado = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private auth: AuthService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit() {
    const token = this.route.snapshot.queryParamMap.get('token');
    const email = this.route.snapshot.queryParamMap.get('email');
    if (!token || !email) {
      this.carregando = false;
      this.erro = 'Link de confirmação inválido.';
      return;
    }
    this.auth.confirmarEmail(email, token).subscribe({
      next: (res) => {
        this.carregando = false;
        this.jaConfirmado = !!res.jaConfirmado;
        this.cdr.detectChanges();
        setTimeout(() => this.router.navigate([this.jaConfirmado ? '/login' : '/recebimentos']), this.jaConfirmado ? 2500 : 1200);
      },
      error: (e) => {
        this.carregando = false;
        this.erro = e.error?.erro || 'Não foi possível confirmar seu e-mail.';
        this.cdr.detectChanges();
      },
    });
  }
}
