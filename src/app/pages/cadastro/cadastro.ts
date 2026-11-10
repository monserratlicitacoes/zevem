import { Component, ChangeDetectorRef, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-cadastro',
  imports: [FormsModule, RouterLink],
  templateUrl: './cadastro.html',
  styleUrls: ['../login/login.scss', './cadastro.scss'],
})
export class Cadastro implements OnInit {
  readonly ano = new Date().getFullYear();
  nome = '';
  email = '';
  senha = '';
  erro = '';
  carregando = false;
  enviado = false;
  avisoEmail: string | null = null;

  // Convite do master (/cadastro?convite=...): e-mail fixo e entrada direta no app
  convite = '';
  erroConvite = '';

  constructor(private auth: AuthService, private cdr: ChangeDetectorRef, private route: ActivatedRoute, private router: Router) {}

  ngOnInit() {
    this.convite = this.route.snapshot.queryParamMap.get('convite') || '';
    if (!this.convite) return;
    this.auth.convite(this.convite).subscribe({
      next: (c) => { this.email = c.email; this.nome = this.nome || c.nome; this.cdr.detectChanges(); },
      error: (e) => {
        this.convite = '';
        this.erroConvite = e.error?.erro || 'Este convite não vale mais. Peça um novo a quem te convidou.';
        this.cdr.detectChanges();
      },
    });
  }

  cadastrar() {
    if (!this.nome || !this.email || !this.senha) return;
    if (this.senha.length < 8) {
      this.erro = 'A senha deve ter no mínimo 8 caracteres.';
      return;
    }
    this.carregando = true;
    this.erro = '';
    this.auth.cadastrar(this.nome, this.email, this.senha, this.convite || undefined).subscribe({
      next: (res) => {
        if (res.token) { this.router.navigate(['/dashboard']); return; }
        this.carregando = false;
        this.enviado = true;
        this.avisoEmail = res.aviso_email;
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.carregando = false;
        this.erro = e.error?.erro || 'Erro ao criar cadastro.';
        this.cdr.detectChanges();
      },
    });
  }
}
