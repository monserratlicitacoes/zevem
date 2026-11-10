import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  PessoaService,
  Pessoa,
  OPCOES_RISCO,
  OPCOES_FACILIDADE,
} from '../../services/pessoa.service';
import { CartaoService, Cartao, Banco, BANCOS } from '../../services/cartao.service';
import { VideoBadge } from '../../shared/video-badge/video-badge';
import { MinhaAssinaturaQuadro } from '../../shared/minha-assinatura/minha-assinatura';
import { SegurancaConta } from '../../shared/seguranca-conta/seguranca-conta';

const LIMITE_PESSOAS = 2;

@Component({
  selector: 'app-configuracoes',
  imports: [FormsModule, VideoBadge, MinhaAssinaturaQuadro, SegurancaConta],
  templateUrl: './configuracoes.html',
  styleUrl: './configuracoes.scss',
})
export class Configuracoes implements OnInit {
  opcoesRisco = OPCOES_RISCO;
  opcoesFacilidade = OPCOES_FACILIDADE;
  bancos = BANCOS;

  pessoas: Pessoa[] = [];
  cartoes: Cartao[] = [];
  carregando = true;

  // ── Modal pessoa ──
  modalPessoaAberto = false;
  formPessoa: Pessoa = this.pessoaVazia();
  editandoPessoaId: number | null = null;
  enviadoPessoa = false;
  salvandoPessoa = false;
  erroPessoa = '';

  // ── Modal cartão ──
  modalCartaoAberto = false;
  formCartao: Cartao = { nome: '' };
  editandoCartaoId: number | null = null;
  enviadoCartao = false;
  salvandoCartao = false;
  erroCartao = '';

  constructor(
    private pessoaService: PessoaService,
    private cartaoService: CartaoService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit() {
    this.carregarTudo();
  }

  carregarTudo() {
    this.carregando = true;
    this.pessoaService.listar().subscribe({
      next: (lista) => {
        this.pessoas = lista;
        this.cartaoService.listar().subscribe({
          next: (cs) => { this.cartoes = cs; this.carregando = false; this.cdr.detectChanges(); },
          error: () => { this.carregando = false; this.cdr.detectChanges(); },
        });
      },
      error: () => { this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  iniciais(nome: string): string {
    return nome.trim().split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase();
  }

  banco(id: string | undefined): Banco {
    return this.bancos.find(b => b.id === id) || this.bancos[this.bancos.length - 1];
  }

  // ════════════════ Pessoa ════════════════
  pessoaVazia(): Pessoa {
    return { nome: '', data_nascimento: '', cpf: '', email: '', telefone: '', risco_renda: '', facilidade_renda: '' };
  }

  get limitePessoasAtingido(): boolean {
    return this.pessoas.length >= LIMITE_PESSOAS;
  }

  abrirNovaPessoa() {
    if (this.limitePessoasAtingido) {
      alert(`Limite de ${LIMITE_PESSOAS} pessoas cadastradas atingido.`);
      return;
    }
    this.formPessoa = this.pessoaVazia();
    this.editandoPessoaId = null;
    this.enviadoPessoa = false;
    this.erroPessoa = '';
    this.modalPessoaAberto = true;
  }

  editarPessoa(p: Pessoa) {
    this.formPessoa = { ...p };
    this.editandoPessoaId = p.id ?? null;
    this.enviadoPessoa = false;
    this.erroPessoa = '';
    this.modalPessoaAberto = true;
  }

  fecharModalPessoa() {
    this.modalPessoaAberto = false;
  }

  onCpf(e: Event) {
    const v = (e.target as HTMLInputElement).value.replace(/\D/g, '');
    this.formPessoa.cpf = v.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2').slice(0, 14);
  }

  onTelefone(e: Event) {
    const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 11);
    this.formPessoa.telefone = v.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4,5})(\d{4})$/, '$1-$2');
  }

  salvarPessoa() {
    this.enviadoPessoa = true;
    this.erroPessoa = '';
    if (!this.formPessoa.nome) return;

    this.salvandoPessoa = true;
    const obs = this.editandoPessoaId
      ? this.pessoaService.atualizar(this.editandoPessoaId, this.formPessoa)
      : this.pessoaService.criar(this.formPessoa);

    obs.subscribe({
      next: (salvo) => {
        this.salvandoPessoa = false;
        if (this.editandoPessoaId) {
          this.pessoas = this.pessoas.map(p => p.id === salvo.id ? salvo : p);
        } else {
          this.pessoas.push(salvo);
        }
        this.modalPessoaAberto = false;
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.salvandoPessoa = false;
        this.erroPessoa = e.error?.erro || 'Erro ao salvar.';
        this.cdr.detectChanges();
      },
    });
  }

  // ── Confirmação do WhatsApp: a pessoa manda o código do próprio número (prova que o número é dela) ──
  codigoWpp: { pessoaId: number; mensagem: string; numero: string | null; link: string | null } | null = null;
  erroWpp: { pessoaId: number; texto: string } | null = null;

  confirmarWhatsapp(p: Pessoa, event: Event) {
    event.stopPropagation();
    if (!p.id) return;
    this.erroWpp = null;
    this.pessoaService.codigoWhatsapp(p.id).subscribe({
      next: (r) => {
        if (r.ja_confirmado) { p.telefone_verificado = true; this.codigoWpp = null; }
        else this.codigoWpp = { pessoaId: p.id!, mensagem: r.mensagem!, numero: r.numero_zevem ?? null, link: r.link ?? null };
        this.cdr.detectChanges();
      },
      error: (e) => { this.erroWpp = { pessoaId: p.id!, texto: e?.error?.erro || 'Não foi possível gerar o código.' }; this.cdr.detectChanges(); },
    });
  }

  excluirPessoa(p: Pessoa, event: Event) {
    event.stopPropagation();
    if (!p.id || !confirm(`Excluir "${p.nome}"?\n\nA categoria de gastos dessa pessoa também será apagada, com todos os itens e lançamentos.`)) return;
    this.pessoaService.excluir(p.id).subscribe({
      next: () => { this.pessoas = this.pessoas.filter(x => x.id !== p.id); this.cdr.detectChanges(); },
    });
  }

  // ════════════════ Cartão ════════════════
  cartaoVazio(): Cartao {
    return { nome: '', ultimos_digitos: '', banco: '', dia_fechamento: null, dia_vencimento: null };
  }

  abrirNovoCartao() {
    this.formCartao = this.cartaoVazio();
    this.editandoCartaoId = null;
    this.enviadoCartao = false;
    this.erroCartao = '';
    this.modalCartaoAberto = true;
  }

  onUltimosDigitos(e: Event) {
    this.formCartao.ultimos_digitos = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 4);
  }

  selecionarBanco(id: string) {
    this.formCartao.banco = id;
  }

  // Dia do mês da fatura: só dígitos, 1 a 31 (vazio = não informado). Um segundo dígito que
  // passaria de 31 é descartado ("45" fica "4"); zero vira vazio.
  onDiaCartao(e: Event, campo: 'dia_fechamento' | 'dia_vencimento') {
    const input = e.target as HTMLInputElement;
    let digitos = input.value.replace(/\D/g, '').slice(0, 2);
    if (parseInt(digitos, 10) > 31) digitos = digitos.slice(0, 1);
    const n = parseInt(digitos, 10);
    this.formCartao[campo] = n >= 1 ? n : null;
    input.value = this.formCartao[campo]?.toString() ?? '';
  }

  editarCartao(c: Cartao) {
    this.formCartao = { ...c };
    this.editandoCartaoId = c.id ?? null;
    this.enviadoCartao = false;
    this.erroCartao = '';
    this.modalCartaoAberto = true;
  }

  fecharModalCartao() {
    this.modalCartaoAberto = false;
  }

  salvarCartao() {
    this.enviadoCartao = true;
    this.erroCartao = '';
    if (!this.formCartao.nome) return;

    this.salvandoCartao = true;
    const obs = this.editandoCartaoId
      ? this.cartaoService.atualizar(this.editandoCartaoId, this.formCartao)
      : this.cartaoService.criar(this.formCartao);

    obs.subscribe({
      next: (salvo) => {
        this.salvandoCartao = false;
        if (this.editandoCartaoId) {
          this.cartoes = this.cartoes.map(c => c.id === salvo.id ? salvo : c);
        } else {
          this.cartoes.push(salvo);
        }
        this.modalCartaoAberto = false;
        this.cdr.detectChanges();
      },
      error: (e) => {
        this.salvandoCartao = false;
        this.erroCartao = e.error?.erro || 'Erro ao salvar.';
        this.cdr.detectChanges();
      },
    });
  }

  excluirCartao(c: Cartao, event: Event) {
    event.stopPropagation();
    if (!c.id || !confirm(`Excluir "${c.nome}"?`)) return;
    this.cartaoService.excluir(c.id).subscribe({
      next: () => { this.cartoes = this.cartoes.filter(x => x.id !== c.id); this.cdr.detectChanges(); },
    });
  }
}
