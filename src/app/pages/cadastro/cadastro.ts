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
  tipoConvite: 'cliente' | 'planejador' = 'cliente';
  planejadorConvite = ''; // nome do planejador que convidou o cliente
  cpf = '';
  telefone = '';

  constructor(private auth: AuthService, private cdr: ChangeDetectorRef, private route: ActivatedRoute, private router: Router) {}

  ngOnInit() {
    this.convite = this.route.snapshot.queryParamMap.get('convite') || '';
    if (!this.convite) return;
    this.auth.convite(this.convite).subscribe({
      next: (c) => {
        this.email = c.email; this.nome = this.nome || c.nome;
        this.tipoConvite = c.tipo || 'cliente'; this.planejadorConvite = c.planejador || '';
        if (c.tipo === 'planejador') { this.cpf = this.mascaraCpf(c.cpf || ''); this.telefone = this.mascaraTelefone(c.telefone || ''); }
        this.cdr.detectChanges();
      },
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
    const planejador = this.tipoConvite === 'planejador';
    if (planejador && (this.cpf.replace(/\D/g, '').length !== 11 || this.telefone.replace(/\D/g, '').length < 10)) {
      this.erro = 'Informe o CPF e o telefone com DDD.';
      return;
    }
    this.carregando = true;
    this.erro = '';
    this.auth.cadastrar(this.nome, this.email, this.senha, this.convite || undefined, planejador ? { cpf: this.cpf, telefone: this.telefone } : {}).subscribe({
      next: (res) => {
        if (res.token) { this.router.navigate([planejador ? '/planejador/clientes' : '/dashboard']); return; }
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
}
