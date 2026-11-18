import { ChangeDetectorRef, Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';

// Página pública de venda (/assinar), com a identidade visual da MEVEM (verde-limão sobre quase-preto).
// Enquanto o gateway de pagamento não estiver ligado, o formulário registra o pedido e avisa o master
// por e-mail; o acesso é liberado pelo convite (Master › Enviar convite) depois do pagamento.
// Textos, números e preço ficam aqui e no HTML para serem ajustados à vontade.
@Component({
  selector: 'app-assinar',
  imports: [FormsModule, RouterLink],
  templateUrl: './assinar.html',
  styleUrl: './assinar.scss',
})
export class Assinar {
  readonly ano = new Date().getFullYear();
  readonly preco = '27,90';

  readonly numeros = [
    { valor: '10 anos', texto: 'de experiência em planejamento financeiro' },
    { valor: '+1.400', texto: 'clientes atendidos com a metodologia' },
    { valor: '99,8%', texto: 'de aprovação dos clientes' },
  ];

  readonly passos = [
    { titulo: 'Monte o seu plano, com orientação', texto: 'Em cada etapa, um vídeo curto mostra o que fazer e por quê. Você monta o seu próprio planejamento, no seu ritmo, sem se perder.' },
    { titulo: 'O sistema organiza para você', texto: 'A inteligência artificial lê as faturas do cartão, classifica os gastos e cruza tudo com a metodologia, para que nada fique de fora.' },
    { titulo: 'Acompanhe no dia a dia', texto: 'Depois de montado, o Zevem avisa quanto você ainda pode gastar em cada item, quando cada conta vence e quanto já atingiu das suas metas.' },
  ];

  readonly recursos = [
    { icone: '◎', titulo: 'Quanto você pode gastar', texto: 'Um limite claro para cada item do orçamento, atualizado a cada gasto lançado.' },
    { icone: '◷', titulo: 'Datas de pagamento no radar', texto: 'Vencimentos das contas e da fatura de cada cartão, para não pagar juros por esquecimento.' },
    { icone: '▲', titulo: 'Metas de gastos', texto: 'Veja quanto já atingiu de cada meta e ajuste o mês antes que ele termine.' },
    { icone: '✦', titulo: 'Fatura lida por IA', texto: 'Envie o PDF da fatura e os lançamentos entram classificados, prontos para conferir.' },
    { icone: '◆', titulo: 'Dívidas sob controle', texto: 'Simule financiamentos e quitação antecipada e descubra qual caminho economiza mais juros.' },
    { icone: '★', titulo: 'Sonhos com prazo e valor', texto: 'Aposentadoria, imóvel, carro, viagem: quanto investir por mês para chegar lá.' },
  ];

  readonly incluso = [
    'Acesso completo ao app Zevem',
    'Metodologia MEVEM passo a passo, com vídeos',
    'Leitura de faturas por inteligência artificial',
    'Orçamento, metas, dívidas e sonhos em um só lugar',
    'Cancelamento quando quiser',
  ];

  readonly perguntas = [
    { p: 'Preciso entender de finanças para usar?', r: 'Não. O Zevem foi feito para quem quer começar: cada passo vem com orientação em vídeo e o sistema faz as contas por você.' },
    { p: 'Como recebo o acesso?', r: 'Depois da confirmação do pagamento, você recebe no seu e-mail o link para criar a sua conta e entrar no app.' },
    { p: 'Meus dados ficam seguros?', r: 'Sim. Dados pessoais são guardados cifrados, e o arquivo da fatura não fica salvo: só os lançamentos extraídos.' },
    { p: 'Posso cancelar?', r: 'Pode, quando quiser, direto pelo app ou pelo atendimento.' },
  ];

  nome = '';
  email = '';
  cpf = '';
  telefone = '';
  aceite = false;
  site = ''; // campo-armadilha para robôs (fica escondido)
  enviando = false;
  enviado = false;
  erro = '';

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  irPara(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  mascaraCpf(v: string): string {
    const d = v.replace(/\D/g, '').slice(0, 11);
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }

  mascaraTelefone(v: string): string {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  assinar() {
    this.erro = '';
    if (!this.nome.trim() || !this.email.trim() || !this.cpf || !this.telefone) {
      this.erro = 'Preencha nome, e-mail, CPF e telefone.';
      return;
    }
    if (!this.aceite) {
      this.erro = 'Para continuar, aceite os termos de uso e a política de privacidade.';
      return;
    }
    this.enviando = true;
    this.http.post(`${environment.apiUrl}/assinar`, {
      nome: this.nome, email: this.email, cpf: this.cpf, telefone: this.telefone, aceite: this.aceite, site: this.site,
    }).subscribe({
      next: () => { this.enviando = false; this.enviado = true; this.cdr.detectChanges(); },
      error: (e) => {
        this.enviando = false;
        this.erro = e?.status === 0 ? 'Sem conexão com o servidor. Tente de novo em instantes.'
          : e?.status === 429 ? 'Muitas tentativas. Tente de novo mais tarde.'
          : e?.error?.erro || 'Não foi possível registrar o pedido. Tente de novo.';
        this.cdr.detectChanges();
      },
    });
  }
}
