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

// Master ou planejador dentro do Zevem de um cliente: de quem é a conta e para onde voltar
export interface AcessoCliente {
  cliente: string;
  voltarPara: string;
}

const CHAVE_SUPORTE = 'zevem-acesso-cliente';
const CHAVE_ORIGINAL = 'zevem-sessao-original';
const lerJson = <T>(chave: string): T | null => {
  try { return JSON.parse(localStorage.getItem(chave) || 'null'); } catch { return null; }
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = `${environment.apiUrl}/auth`;

  // Usuário master (área de clientes, anúncios e financeiro). null = ainda não consultado.
  readonly master = signal<boolean | null>(null);
  // Planejador financeiro associado (área "Meus clientes"). Consultado junto com o master.
  readonly planejador = signal(false);
  // Cliente que já tem planejador (usuarios.planejador_id): não vê o anúncio "Contrate um planejador"
  readonly temPlanejador = signal(false);
  // E-mail de quem está logado (null = ninguém): os dados guardados no navegador são separados por ele
  readonly usuarioAtual = signal<string | null>(localStorage.getItem('email'));
  // Preenchido enquanto o master ou o planejador está usando o Zevem de um cliente
  readonly suporte = signal<AcessoCliente | null>(lerJson<AcessoCliente>(CHAVE_SUPORTE));

  constructor(private http: HttpClient, private router: Router) {}

  carregarPapel(): Observable<boolean> {
    if (this.master() !== null) return of(this.master()!);
    return this.http.get<{ master: boolean; planejador?: boolean; tem_planejador?: boolean }>(`${this.api}/papel`).pipe(
      tap((r) => { this.planejador.set(!!r.planejador); this.temPlanejador.set(!!r.tem_planejador); this.master.set(!!r.master); }),
      map((r) => !!r.master),
      // Falha de rede não grava nada: a próxima consulta tenta de novo (não tranca o master fora da área dele)
      catchError(() => of(false)),
    );
  }

  // Tela inicial depois de entrar: o planejador cai em "Meus clientes"
  telaInicial(): Observable<string> {
    return this.carregarPapel().pipe(map(() => (this.planejador() ? '/planejador/clientes' : '/recebimentos')));
  }

  // Com convite a conta já nasce confirmada e volta com a sessão (token)
  cadastrar(nome: string, email: string, senha: string, convite?: string, extra: { cpf?: string; telefone?: string } = {}) {
    return this.http.post<{ ok: boolean; aviso_email: string | null } & Partial<AuthPayload>>(`${this.api}/cadastro`, { nome, email, senha, convite, ...extra }).pipe(
      tap((res) => { if (res.token) this.salvarSessao(res as AuthPayload); }),
    );
  }

  convite(token: string) {
    return this.http.get<{ email: string; nome: string; tipo: 'cliente' | 'planejador'; planejador: string; cpf?: string; telefone?: string }>(`${environment.apiUrl}/convites/${encodeURIComponent(token)}`);
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

  // Entra no Zevem do cliente guardando a própria sessão para voltar depois
  entrarNaContaDoCliente(res: AuthPayload, voltarPara: string) {
    if (!this.suporte()) {
      localStorage.setItem(CHAVE_ORIGINAL, JSON.stringify({ token: this.token, nome: this.nome, email: this.email }));
    }
    this.salvarSessao(res);
    const acesso: AcessoCliente = { cliente: res.nome, voltarPara };
    localStorage.setItem(CHAVE_SUPORTE, JSON.stringify(acesso));
    this.suporte.set(acesso);
    this.router.navigate(['/dashboard']);
  }

  // Volta para a própria conta (ou para o login, se a sessão guardada não existir mais)
  voltarDaContaDoCliente() {
    const original = lerJson<AuthPayload>(CHAVE_ORIGINAL);
    const destino = this.suporte()?.voltarPara || '/';
    this.limparSuporte();
    if (!original?.token) { this.logout(); return; }
    this.salvarSessao(original);
    this.router.navigateByUrl(destino);
  }

  private limparSuporte() {
    localStorage.removeItem(CHAVE_SUPORTE);
    localStorage.removeItem(CHAVE_ORIGINAL);
    this.suporte.set(null);
  }

  // Sessão que chega pronta de fora do login (checkout: pagou, criou a senha e entra na hora)
  entrarComSessao(res: AuthPayload) {
    this.limparSuporte();
    this.salvarSessao(res);
  }

  private salvarSessao(res: AuthPayload) {
    this.master.set(null); // outro usuário pode ter entrado: consulta o papel de novo
    this.planejador.set(false);
    this.temPlanejador.set(false);
    localStorage.setItem('token', res.token);
    localStorage.setItem('nome', res.nome);
    localStorage.setItem('email', res.email);
    this.usuarioAtual.set(res.email);
  }

  // Apaga só a sessão: preferências do navegador (progresso, tema do Dashboard etc.) continuam.
  logout() {
    ['token', 'nome', 'email'].forEach((k) => localStorage.removeItem(k));
    this.limparSuporte();
    this.master.set(null);
    this.planejador.set(false);
    this.temPlanejador.set(false);
    this.usuarioAtual.set(null);
    this.router.navigate(['/login']);
  }

  get token(): string | null { return localStorage.getItem('token'); }
  get nome(): string | null { return localStorage.getItem('nome'); }
  get email(): string | null { return localStorage.getItem('email'); }
  get isLoggedIn(): boolean { return !!this.token; }
}
