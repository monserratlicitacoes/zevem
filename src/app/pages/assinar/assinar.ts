import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

// Página pública de venda (/assinar), com a identidade visual da MEVEM (verde-limão sobre quase-preto).
// Os botões de assinar abrem o checkout (/checkout): o cliente paga ali mesmo (Asaas) e entra no app na hora.
// Textos, números e preço ficam aqui e no HTML para serem ajustados à vontade.
@Component({
  selector: 'app-assinar',
  imports: [RouterLink],
  templateUrl: './assinar.html',
  styleUrl: './assinar.scss',
})
export class Assinar {
  readonly ano = new Date().getFullYear();
  readonly preco = '27,90';
  readonly precoAno = '334,80'; // 12 × 27,90
  readonly fundador = 'João Gondim Neto';

  // Minha foto e meu vídeo da abertura: coloque os arquivos em public/lp/ com estes nomes.
  // Sem vídeo (string vazia), a abertura mostra só a foto; sem foto, mostra as iniciais.
  readonly foto = '/lp/joao-abertura.webp';          // abertura (moldura 4:5)
  readonly fotoFundador = '/lp/joao-fundador.webp';  // seção "Quem te acompanha" (círculo)
  readonly video = ''; // ex.: '/lp/joao.mp4'
  readonly fotoOk = signal(true);
  readonly fotoFundadorOk = signal(true);

  private router = inject(Router);

  readonly pontosFortes = [
    'Proteja sua qualidade de vida no presente',
    'Garanta sua qualidade de vida no futuro',
    'Coloque um fim na falta de clareza da sua vida financeira',
  ];

  // O que é o Zevem: a mistura de curso, sistema e IA
  readonly formula = [
    { icone: 'curso', titulo: 'Curso de Planejamento Financeiro', texto: 'Eu te ensino, em vídeos objetivos, a montar o seu próprio planejamento no seu ritmo.' },
    { icone: 'sistema', titulo: 'Sistema de gestão de orçamento pessoal', texto: 'Orçamento, metas, dívidas e sonhos organizados em um só lugar.' },
    { icone: 'ia', titulo: 'Inteligência artificial para te orientar sobre gastos', texto: 'Orientações frequentes sobre o que fazer com o seu dinheiro, direto no seu WhatsApp.' },
  ];

  readonly numeros = [
    { valor: '10 anos', texto: 'de experiência em planejamento financeiro' },
    { valor: '+1.400', texto: 'clientes atendidos com a metodologia' },
    { valor: '+100', texto: 'planejadores financeiros formados' },
    { valor: '99,8%', texto: 'de aprovação dos clientes' },
  ];

  readonly passos = [
    { titulo: 'Eu te ensino a montar o seu plano', texto: 'Em cada etapa, eu te explico num vídeo curto o que fazer e por quê. Você monta o seu planejamento no seu ritmo, sem se perder.' },
    { titulo: 'A inteligência artificial organiza', texto: 'Você importa a fatura do cartão ou lança pelo WhatsApp. A IA classifica os gastos e cruza tudo com a minha metodologia.' },
    { titulo: 'Eu te acompanho no dia a dia', texto: 'Depois de montado, o Zevem te diz quanto ainda pode gastar em cada item, quando cada conta vence e quanto você já atingiu das suas metas.' },
  ];

  // Zevem × outros apps: do lado dos outros, sempre a mesma frase (proposital)
  readonly outrosApps = 'Você fica anotando gastos.';
  readonly contraste = [
    'Eu te ensino enquanto você monta seu planejamento.',
    'Você importa faturas e recebe orientações frequentes.',
    'Você planeja seus objetivos, até a aposentadoria.',
    'Você tem uma visão clara do seu orçamento.',
    'Você sai das dívidas pelo caminho mais barato.',
    'Você recebe no WhatsApp orientações sobre gastos e limites.',
    'Uma IA treinada com meus 10 anos de planejamento trabalhando por você.',
  ];

  readonly recursos = [
    { icone: '◎', titulo: 'Quanto você pode gastar', texto: 'Um limite claro para cada item do orçamento, atualizado a cada gasto lançado.' },
    { icone: '◷', titulo: 'Datas de pagamento no radar', texto: 'Vencimentos das contas e da fatura de cada cartão, para não pagar juros por esquecimento.' },
    { icone: '▲', titulo: 'Metas de gastos', texto: 'Veja quanto já atingiu de cada meta e ajuste o mês antes que ele termine.' },
    { icone: '✦', titulo: 'Fatura lida por IA', texto: 'Envie o PDF da fatura e os lançamentos entram classificados, prontos para conferir.' },
    { icone: '◆', titulo: 'Dívidas sob controle', texto: 'Simule financiamentos e quitação antecipada e descubra qual caminho economiza mais juros.' },
    { icone: '★', titulo: 'Sonhos com prazo e valor', texto: 'Aposentadoria, imóvel, carro, viagem: quanto investir por mês para chegar lá.' },
  ];

  // Depoimentos: preencha texto, nome e detalhe (ex.: 'Goiânia · médica'). Vazios aparecem como modelo.
  readonly depoimentos = [
    { texto: '', nome: '', detalhe: '' },
    { texto: '', nome: '', detalhe: '' },
    { texto: '', nome: '', detalhe: '' },
    { texto: '', nome: '', detalhe: '' },
    { texto: '', nome: '', detalhe: '' },
    { texto: '', nome: '', detalhe: '' },
  ];

  readonly incluso = [
    'Acesso completo ao app Zevem',
    'A minha metodologia passo a passo, com vídeos',
    'Leitura de faturas por inteligência artificial',
    'Lançamentos pelo WhatsApp',
    'Orçamento compartilhado com o cônjuge',
    'Orçamento, metas, dívidas e sonhos em um só lugar',
    'Garantia de 30 dias ou o seu dinheiro de volta',
  ];

  readonly perguntas = [
    { p: 'Preciso entender de finanças para usar?', r: 'Não. Esse é o meu trabalho. Eu te mostro cada passo em vídeo e o Zevem faz as contas por você.' },
    { p: 'Você vai me atender pessoalmente?', r: 'Melhor que isso. Eu vou explicar cada passo em vídeos objetivos para você conseguir construir seu próprio planejamento financeiro no seu ritmo.' },
    { p: 'O que o Zevem tem de diferente dos outros apps?', r: 'Os outros só registram gastos. No Zevem eu te ensino a planejar, e o app te diz quanto pode gastar, quando pagar e quanto falta para as suas metas.' },
    { p: 'Por que custa tão pouco, se um planejador cobra R$ 15 mil por ano?', r: 'Porque eu coloquei a minha metodologia e 10 anos de experiência dentro de um sistema. Você tem a orientação de um planejador pelo preço de um app.' },
    { p: 'Quanto tempo leva para montar o meu planejamento?', r: 'Você monta no seu ritmo, com vídeos curtos. E já no primeiro mês o Zevem começa a te orientar com os seus números.' },
    { p: 'Posso lançar os gastos pelo WhatsApp?', r: 'Pode. Você manda o gasto numa mensagem e ele entra direto no seu orçamento, sem abrir o app.' },
    { p: 'Sou casado. Dá para usar junto com o meu cônjuge?', r: 'Dá. Você adiciona o seu cônjuge e os dois lançam e acompanham o mesmo orçamento.' },
    { p: 'Como a inteligência artificial me ajuda?', r: 'Ela lê o PDF da sua fatura, classifica os gastos e foi treinada com a minha metodologia para te orientar a partir dos seus números.' },
    { p: 'Funciona no celular?', r: 'O Zevem é feito para o computador, onde você tem a visão completa do seu planejamento. No dia a dia, pelo celular, você lança gastos e recebe as minhas orientações pelo WhatsApp.' },
    { p: 'Meus dados ficam seguros?', r: 'Sim. Dados pessoais são guardados cifrados, e o arquivo da fatura não fica salvo: só os lançamentos extraídos.' },
    { p: 'Como recebo o acesso?', r: 'Na hora. Assim que o pagamento é aprovado, você cria a sua senha ali mesmo e já entra no app.' },
    { p: 'E se eu não gostar?', r: 'Você tem 30 dias de garantia. Se não for para você, é só pedir e eu devolvo 100% do valor pago.' },
    { p: 'Como funciona o pagamento?', r: 'O plano é anual, em 12x de R$ 27,90 no cartão de crédito, ou à vista no Pix. O pagamento é feito aqui mesmo, em ambiente seguro, e você entra no app na hora.' },
  ];

  iniciais(nome: string): string {
    const partes = nome.trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return '?';
    return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')).toUpperCase();
  }

  irPara(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Botões de assinar: abrem o checkout
  pagar() {
    this.router.navigate(['/checkout']);
  }
}
