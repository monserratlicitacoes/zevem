import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService, AuthPayload } from '../../services/auth.service';

// Checkout da página de venda, em 4 etapas na mesma tela (sem sair do Zevem):
//   1. Quem é você → 2. Seu plano → 3. Pagamento (cartão em 12x ou Pix) → 4. Ativação (cria a senha e entra).
// Pagamento pelo Asaas, feito pelo backend (backend/checkout.js). Depois de pagar, o cliente cria a senha
// e cai direto no app, sem redirecionamento para fora nem e-mail de confirmação.
// O id do checkout fica no sessionStorage: recarregar a página no meio do Pix não perde a compra.

interface Plano { nome: string; valor_anual: number; parcelas: number; valor_parcela: number; disponivel: boolean }
// Preço desta compra, com o cupom (se houver). O desconto vale só para o 1º ano.
interface Preco { valor_anual: number; valor_parcela: number; parcelas: number; valor_cheio: number; cupom: { codigo: string; desconto: number } | null }
type Etapa = 1 | 2 | 3 | 4;
type Forma = 'cartao' | 'pix';

const CHAVE = 'zevem_checkout';
const api = environment.apiUrl;

@Component({
  selector: 'app-checkout',
  imports: [FormsModule, RouterLink],
  templateUrl: './checkout.html',
  styleUrl: './checkout.scss',
})
export class Checkout implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private router = inject(Router);
  private auth = inject(AuthService);

  readonly etapas = [
    { n: 1, titulo: 'Quem é você', texto: 'Seus dados para a conta' },
    { n: 2, titulo: 'Seu plano', texto: 'Plano anual do Zevem' },
    { n: 3, titulo: 'Pagamento', texto: 'Cartão ou Pix, aqui mesmo' },
    { n: 4, titulo: 'Ativação', texto: 'Crie a senha e entre na hora' },
  ] as const;

  readonly etapa = signal<Etapa>(1);
  readonly plano = signal<Plano | null>(null);
  readonly precoCupom = signal<Preco | null>(null);
  // O que aparece na tela: com cupom, o preço com desconto; sem, o do plano
  readonly valor = computed(() => {
    const c = this.precoCupom();
    const p = this.plano();
    return {
      valor_anual: c?.valor_anual ?? p?.valor_anual ?? 0,
      valor_parcela: c?.valor_parcela ?? p?.valor_parcela ?? 0,
      valor_cheio: c?.valor_cheio ?? p?.valor_anual ?? 0,
      cupom: c?.cupom ?? null,
    };
  });
  cupomAberto = false;
  codigoCupom = '';
  readonly erroCupom = signal('');
  readonly aplicandoCupom = signal(false);
  readonly carregando = signal(false);
  readonly erro = signal('');
  readonly contaExiste = signal(false);
  readonly forma = signal<Forma>('cartao');
  readonly pix = signal<{ qr: string; copia: string } | null>(null);
  readonly copiado = signal(false);
  readonly jaAtivado = signal(false);

  id = '';
  dados = { nome: '', email: '', telefone: '', cpf: '', site: '' };
  cartao = { numero: '', nome: '', validade: '', cvc: '' };
  titular = { cpf: '', cep: '', numero: '' };
  outroTitular = false;
  senha = '';
  senha2 = '';
  verSenha = false;

  private espera?: ReturnType<typeof setInterval>;

  readonly progresso = computed(() => ((this.etapa() - 1) / 3) * 100);
  readonly bandeira = signal('');

  ngOnInit() {
    this.http.get<Plano>(`${api}/checkout/plano`).subscribe({
      next: (p) => this.plano.set(p),
      error: () => this.plano.set({ nome: 'Zevem Anual', valor_anual: 334.8, parcelas: 12, valor_parcela: 27.9, disponivel: false }),
    });
    // Compra em andamento (recarregou a página): retoma de onde parou
    const salvo = this.lerSalvo();
    if (salvo?.id) {
      this.id = salvo.id;
      this.dados = { ...this.dados, ...salvo.dados };
      this.http.get<{ status: string; forma: Forma | null }>(`${api}/checkout/${this.id}/status`).subscribe({
        next: (s) => {
          if (s.status === 'pago') this.irPara(4);
          else if (s.status === 'ativado') { this.jaAtivado.set(true); this.irPara(4); }
          else if (s.status === 'aguardando_pix') { this.forma.set('pix'); this.irPara(3); this.gerarPix(); }
          else this.irPara(salvo.etapa === 3 ? 3 : 2);
          this.http.get<Preco>(`${api}/checkout/${this.id}/preco`).subscribe({ next: (p) => this.precoCupom.set(p.cupom ? p : null) });
        },
        error: () => this.limparSalvo(),
      });
    }
  }

  ngOnDestroy() { this.pararEspera(); }

  // ── Formatação ──
  moeda(v: number | undefined) {
    return (v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  private digitos(v: string, max: number) { return String(v || '').replace(/\D/g, '').slice(0, max); }
  mascaraCpf(v: string) {
    const d = this.digitos(v, 11);
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  mascaraTelefone(v: string) {
    const d = this.digitos(v, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  mascaraCep(v: string) { const d = this.digitos(v, 8); return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; }
  mascaraCartao(v: string) {
    const d = this.digitos(v, 19);
    this.bandeira.set(
      /^4/.test(d) ? 'Visa'
        : /^(5[1-5]|2[2-7])/.test(d) ? 'Mastercard'
        : /^3[47]/.test(d) ? 'Amex'
        : /^(4011|4312|4389|4514|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/.test(d) ? 'Elo'
        : /^(606282|3841)/.test(d) ? 'Hipercard'
        : '',
    );
    return d.replace(/(\d{4})(?=\d)/g, '$1 ');
  }
  mascaraValidade(v: string) { const d = this.digitos(v, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; }

  // ── Navegação ──
  irPara(e: Etapa) {
    this.erro.set('');
    this.etapa.set(e);
    if (e !== 3) this.pararEspera();
    this.salvar();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  voltar() {
    const e = this.etapa();
    if (e === 2) this.irPara(1);
    else if (e === 3) this.irPara(2);
  }

  private falhou(e: HttpErrorResponse, padrao: string) {
    this.carregando.set(false);
    this.erro.set(e.error?.erro || (e.status === 0 ? 'Sem conexão com o Zevem. Confira a internet e tente de novo.' : padrao));
  }

  // ── 1. Quem é você ──
  continuarDados() {
    this.erro.set('');
    this.contaExiste.set(false);
    const d = this.dados;
    if (d.nome.trim().split(/\s+/).length < 2) return this.erro.set('Informe o seu nome completo.');
    if (!/^\S+@\S+\.\S+$/.test(d.email.trim())) return this.erro.set('Informe um e-mail válido.');
    if (this.digitos(d.telefone, 11).length < 10) return this.erro.set('Informe o WhatsApp com DDD.');
    if (this.digitos(d.cpf, 11).length !== 11) return this.erro.set('Informe o seu CPF.');
    this.carregando.set(true);
    this.http.post<{ id: string }>(`${api}/checkout/iniciar`, { ...d, id: this.id || undefined }).subscribe({
      next: (r) => {
        this.carregando.set(false);
        this.id = r.id;
        this.irPara(2);
      },
      error: (e: HttpErrorResponse) => {
        this.falhou(e, 'Não foi possível continuar. Tente de novo.');
        if (e.error?.conta) this.contaExiste.set(true);
      },
    });
  }

  // ── 3. Pagamento ──
  escolher(f: Forma) {
    this.erro.set('');
    this.forma.set(f);
    if (f === 'pix') this.gerarPix();
    else this.pararEspera();
  }

  pagarCartao() {
    this.erro.set('');
    const c = this.cartao;
    const [mes, ano] = c.validade.split('/');
    const numero = this.digitos(c.numero, 19);
    if (numero.length < 13) return this.erro.set('Confira o número do cartão.');
    if (!c.nome.trim()) return this.erro.set('Informe o nome impresso no cartão.');
    if (!mes || !ano || +mes < 1 || +mes > 12 || ano.length !== 2) return this.erro.set('Informe a validade no formato MM/AA.');
    if (this.digitos(c.cvc, 4).length < 3) return this.erro.set('Informe o código de segurança (CVV).');
    const cpfTitular = this.outroTitular ? this.titular.cpf : this.dados.cpf;
    if (this.digitos(cpfTitular, 11).length !== 11) return this.erro.set('Informe o CPF do titular do cartão.');
    if (this.digitos(this.titular.cep, 8).length !== 8) return this.erro.set('Informe o CEP do titular do cartão.');
    if (!this.titular.numero.trim()) return this.erro.set('Informe o número do endereço.');
    this.carregando.set(true);
    this.http.post<{ status: string }>(`${api}/checkout/${this.id}/cartao`, {
      cartao: { numero, nome: c.nome, mes, ano, cvc: c.cvc },
      titular: { cpf: cpfTitular, cep: this.titular.cep, numero: this.titular.numero },
    }).subscribe({
      next: (r) => {
        this.carregando.set(false);
        this.cartao = { numero: '', nome: '', validade: '', cvc: '' }; // nada do cartão fica na tela
        this.concluirPagamento(r.status);
      },
      error: (e: HttpErrorResponse) => { this.cupomCaiu(e); this.falhou(e, 'O pagamento não foi aprovado. Confira os dados ou use outro cartão.'); },
    });
  }

  // ── Cupom (etapa 2) ──
  aplicarCupom(codigo = this.codigoCupom) {
    this.erroCupom.set('');
    if (!this.id) return;
    const limpo = codigo.trim().toUpperCase().replace(/\s+/g, '');
    if (codigo && !limpo) return this.erroCupom.set('Digite o código do cupom.');
    this.aplicandoCupom.set(true);
    this.http.post<Preco>(`${api}/checkout/${this.id}/cupom`, { codigo: limpo }).subscribe({
      next: (p) => {
        this.aplicandoCupom.set(false);
        this.precoCupom.set(p.cupom ? p : null);
        this.pix.set(null); // o valor mudou: um Pix já gerado não vale mais
        if (!p.cupom) { this.codigoCupom = ''; this.cupomAberto = false; }
      },
      error: (e: HttpErrorResponse) => { this.aplicandoCupom.set(false); this.erroCupom.set(e.error?.erro || 'Não foi possível aplicar o cupom.'); },
    });
  }
  tirarCupom() { this.aplicarCupom(''); }
  // O cupom deixou de valer na hora de pagar (expirou, esgotou): volta o preço cheio e avisa
  private cupomCaiu(e: HttpErrorResponse) {
    if (e.error?.cupom_caiu) { this.precoCupom.set(null); this.codigoCupom = ''; }
  }

  gerarPix() {
    if (this.pix()) { this.esperarPix(); return; }
    this.carregando.set(true);
    this.http.post<{ status: string; qr_imagem?: string; copia_e_cola?: string }>(`${api}/checkout/${this.id}/pix`, {}).subscribe({
      next: (r) => {
        this.carregando.set(false);
        if (r.status === 'pago' || r.status === 'ativado') return this.concluirPagamento(r.status);
        this.pix.set({ qr: r.qr_imagem || '', copia: r.copia_e_cola || '' });
        this.esperarPix();
      },
      error: (e: HttpErrorResponse) => { this.cupomCaiu(e); this.falhou(e, 'Não foi possível gerar o Pix. Tente de novo.'); },
    });
  }

  private esperarPix() {
    this.pararEspera();
    this.espera = setInterval(() => {
      this.http.get<{ status: string }>(`${api}/checkout/${this.id}/status`).subscribe({
        next: (s) => { if (s.status === 'pago' || s.status === 'ativado') this.concluirPagamento(s.status); },
      });
    }, 4000);
  }
  private pararEspera() { if (this.espera) { clearInterval(this.espera); this.espera = undefined; } }

  copiarPix() {
    const texto = this.pix()?.copia;
    if (!texto) return;
    navigator.clipboard?.writeText(texto).then(() => {
      this.copiado.set(true);
      setTimeout(() => this.copiado.set(false), 2500);
    });
  }

  private concluirPagamento(status: string) {
    this.pararEspera();
    if (status === 'ativado') this.jaAtivado.set(true);
    this.irPara(4);
  }

  // ── 4. Ativação: cria a senha e entra ──
  ativar() {
    this.erro.set('');
    if (this.senha.length < 8) return this.erro.set('A senha deve ter no mínimo 8 caracteres.');
    if (this.senha !== this.senha2) return this.erro.set('As senhas não conferem.');
    this.carregando.set(true);
    this.http.post<AuthPayload>(`${api}/checkout/${this.id}/ativar`, { senha: this.senha }).subscribe({
      next: (sessao) => {
        this.limparSalvo();
        this.auth.entrarComSessao(sessao);
        this.auth.telaInicial().subscribe((rota) => { this.carregando.set(false); this.router.navigateByUrl(rota); });
      },
      error: (e: HttpErrorResponse) => {
        this.falhou(e, 'Não foi possível ativar a sua conta. Tente de novo.');
        if (e.error?.conta) this.jaAtivado.set(true);
      },
    });
  }

  // ── Compra em andamento (só id, dados de contato e etapa; nada de cartão) ──
  private salvar() {
    try {
      if (this.id) sessionStorage.setItem(CHAVE, JSON.stringify({ id: this.id, etapa: this.etapa(), dados: { ...this.dados, site: '' } }));
    } catch { /* navegador sem armazenamento */ }
  }
  private lerSalvo(): { id: string; etapa: Etapa; dados: Checkout["dados"] } | null {
    try { return JSON.parse(sessionStorage.getItem(CHAVE) || 'null'); } catch { return null; }
  }
  private limparSalvo() { try { sessionStorage.removeItem(CHAVE); } catch { /* idem */ } }
}
