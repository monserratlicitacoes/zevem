import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface AuthPayload {
  token: string;
  nome: string;
  email: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = `${environment.apiUrl}/auth`;

  // Usuário master (área de clientes, anúncios e financeiro). null = ainda não consultado.
  readonly master = signal<boolean | null>(null);
  // E-mail de quem está logado (null = ninguém): os dados guardados no navegador são separados por ele
  readonly usuarioAtual = signal<string | null>(localStorage.getItem('email'));

  constructor(private http: HttpClient, private router: Router) {}

  carregarPapel(): Observable<boolean> {
    if (this.master() !== null) return of(this.master()!);
    return this.http.get<{ master: boolean }>(`${this.api}/papel`).pipe(
      map((r) => r.master),
      catchError(() => of(false)),
      tap((m) => this.master.set(m)),
    );
  }

  // Com convite a conta já nasce confirmada e volta com a sessão (token)
  cadastrar(nome: string, email: string, senha: string, convite?: string) {
    return this.http.post<{ ok: boolean; aviso_email: string | null } & Partial<AuthPayload>>(`${this.api}/cadastro`, { nome, email, senha, convite }).pipe(
      tap((res) => { if (res.token) this.salvarSessao(res as AuthPayload); }),
    );
  }

  convite(token: string) {
    return this.http.get<{ email: string; nome: string }>(`${environment.apiUrl}/convites/${encodeURIComponent(token)}`);
  }

  // Link já usado (conta confirmada antes): volta sem sessão e a pessoa entra pelo login
  confirmarEmail(email: string, token: string) {
    return this.http.post<{ jaConfirmado?: boolean } & Partial<AuthPayload>>(`${this.api}/confirmar-email`, { email, token }).pipe(
      tap((res) => { if (res.token) this.salvarSessao(res as AuthPayload); }),
    );
  }

  esqueciSenha(email: string) {
    return this.http.post<{ mensagem: string }>(`${this.api}/esqueci-senha`, { email });
  }

  redefinirSenha(email: string, token: string, senha: string) {
    return this.http.post<AuthPayload>(`${this.api}/redefinir-senha`, { email, token, senha }).pipe(
      tap((res) => this.salvarSessao(res)),
    );
  }

  // As outras sessões caem; esta recebe uma sessão nova
  trocarSenha(senha_atual: string, senha_nova: string) {
    return this.http.post<AuthPayload>(`${this.api}/trocar-senha`, { senha_atual, senha_nova }).pipe(
      tap((res) => this.salvarSessao(res)),
    );
  }

  baixarMeusDados() {
    return this.http.get(`${environment.apiUrl}/conta/exportar`, { responseType: 'blob' });
  }

  excluirConta(senha: string) {
    return this.http.post(`${environment.apiUrl}/conta/excluir`, { senha }).pipe(tap(() => this.logout()));
  }

  sairDeTodos() {
    return this.http.post(`${this.api}/sair-todos`, {}).pipe(tap(() => this.logout()));
  }

  login(email: string, senha: string) {
    return this.http.post<AuthPayload>(`${this.api}/login`, { email, senha }).pipe(
      tap((res) => this.salvarSessao(res)),
    );
  }

  devLogin() {
    return this.http.post<AuthPayload>(`${this.api}/dev-login`, {}).pipe(
      tap((res) => this.salvarSessao(res)),
    );
  }

  private salvarSessao(res: AuthPayload) {
    this.master.set(null); // outro usuário pode ter entrado: consulta o papel de novo
    localStorage.setItem('token', res.token);
    localStorage.setItem('nome', res.nome);
    localStorage.setItem('email', res.email);
    this.usuarioAtual.set(res.email);
  }

  // Apaga só a sessão: preferências do navegador (progresso, tema do Dashboard etc.) continuam.
  logout() {
    ['token', 'nome', 'email'].forEach((k) => localStorage.removeItem(k));
    this.master.set(null);
    this.usuarioAtual.set(null);
    this.router.navigate(['/login']);
  }

  get token(): string | null { return localStorage.getItem('token'); }
  get nome(): string | null { return localStorage.getItem('nome'); }
  get email(): string | null { return localStorage.getItem('email'); }
  get isLoggedIn(): boolean { return !!this.token; }
}
