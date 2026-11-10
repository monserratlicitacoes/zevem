// Diagnóstico do nível de saúde orçamentária (1 a 9), mostrado no verso do velocímetro.
// O tom do verso segue as faixas do velocímetro: 1–3 ruim, 4–6 regular, 7–9 ótimo.

import { Diagnostico, NivelComprometimento } from './diagnostico-comprometimento';

type TextoNivel = Pick<Diagnostico, 'abertura' | 'introItens' | 'itens' | 'objetivo'>;

const TEXTOS: Record<number, TextoNivel> = {
  1: {
    abertura: [
      'Seu orçamento provavelmente te deixa muito preocupado. Isso acontece porque os seus pagamentos comprometidos nem sequer cabem dentro do seu orçamento mensal.',
      'São grandes as chances de você, neste momento, estar vivendo um padrão de vida totalmente diferente do que sua renda permite. É hora de rever TODO o seu orçamento, hábitos de consumo e um jeito rápido de sair das dívidas.',
    ],
    introItens: 'O seu planejador pode te ajudar a:',
    itens: [
      'Encontrar estratégias para reduzir o seu nível de endividamento',
      'Trocar dívidas mais caras por dívidas mais baratas',
      'Rever gastos para mudar o seu padrão de vida, na medida do possível sem impactar tanto a sua qualidade de vida',
      'Encontrar meios para reduzir o seu parcelamento no cartão de crédito',
    ],
    objetivo: 'Rever completamente o seu padrão de vida e as escolhas que estão sendo feitas no presente.',
  },
  2: {
    abertura: [
      'É bem provável que você esteja num nível acentuado de endividamento. Todos os pagamentos comprometidos (parcelas de dívidas e gastos mensais comprometidos) cabem na sua renda mensal, mas muitos outros gastos mensais ficam de fora do seu limite de pagamento (supermercado, combustível etc.).',
      'A dica é buscar um acompanhamento constante do orçamento e, principalmente, rever todos os seus gastos mensais: neste momento você pode estar cavando um buraco mais rápido do que consegue tapar e precisando do cheque especial todos os meses.',
    ],
    introItens: 'O seu planejador pode te ajudar a:',
    itens: [
      'Rever o seu padrão de vida, impactando minimamente a sua qualidade de vida',
      'Encontrar alternativas para o pagamento das dívidas',
      'Organizar sua rotina de parcelamentos para evitar o cheque especial',
      'Cortar gastos desnecessários que estão te trazendo mais ansiedade que prazer',
    ],
    objetivo: 'Rever o padrão de vida e as escolhas que estão sendo feitas no presente.',
  },
  3: {
    abertura: [
      'Você está muito perto de fechar seu orçamento longe do vermelho. Pessoas com orçamento nível 3 pagam as contas mensais, mas as “eventualidades” normalmente atrapalham a fechar o mês no zero a zero.',
      'Ou seja, há uma grande chance de você entrar no mês acreditando que as contas vão fechar, mas a fatura do cartão vem mais alta que o previsto com a troca do pneu do carro, as festas de fim de ano ou o presente do Dia das Mães.',
    ],
    introItens: 'Para o seu perfil, o planejador será muito útil para:',
    itens: [
      'Rever seus gastos, enxugando o orçamento de forma estratégica sem impactar a sua qualidade de vida',
      'Organizar os seus parcelamentos e a gestão dos seus Eventuais Flexíveis',
      'Construir uma reserva para os seus Eventuais Comprometidos, para pagá-los sem se apertar quando surgirem',
      'Estabelecer limites e acompanhar seus parcelamentos',
    ],
    objetivo: 'Fazer uma gestão mais ativa do orçamento, acompanhando os gastos, especialmente os eventuais e parcelados.',
  },
  4: {
    abertura: [
      'Atenção! Você pode estar bem próximo de se tornar uma pessoa endividada. Pessoas com orçamento nível 4 fecham as contas mensais com a receita mensal, mas seus gastos eventuais são maiores que a renda eventual.',
      'Ou seja, é preciso estar muito atento às contas mensais, pois aquela renda extra não conseguirá apagar o incêndio dos gastos extras. É fundamental rever especialmente seus gastos Eventuais e, se necessário, checar com bastante atenção os seus gastos Mensais Flexíveis.',
    ],
    introItens: 'Peça auxílio ao seu planejador para:',
    itens: [
      'Encontrar meios estratégicos de rever seus gastos eventuais',
      'Buscar alternativas para reduzir o seu comprometimento mensal e seus gastos mensais flexíveis',
      'Rever o seu padrão de vida atual para que ele não comprometa o seu padrão de vida futuro',
    ],
    objetivo: 'Enxugar gastos e fazer uma gestão cuidadosa dos gastos eventuais.',
  },
  5: {
    abertura: [
      'O orçamento de nível 5 é o clássico regular: paga as contas mensais com a receita mensal e as eventuais com as receitas eventuais.',
      'Neste caso, o principal objetivo é enxugar os gastos para começar a encaixar sua meta de investimento mensal, fundamental para viabilizar a realização dos seus sonhos.',
    ],
    introItens: 'Peça auxílio ao seu planejador para:',
    itens: [
      'Criar estratégias para enxugar gastos sem impactar a sua qualidade ou padrão de vida',
      'Dar atenção especial aos gastos flexíveis (mensais e eventuais) para ter mais previsibilidade',
      'Ficar atento aos limites estabelecidos para a fatura do cartão de crédito',
      'Garantir a provisão dos Eventuais Comprometidos, para que nenhum mês fique sem investimento',
    ],
    objetivo: 'Enxugar gastos.',
  },
  6: {
    abertura: [
      'Pessoas com orçamentos como o seu, nível 6, são “quase investidores”. É possível que sobre algum dinheiro e que você consiga juntar quando surgem as receitas eventuais, pois todos os seus gastos já cabem nas receitas mensais.',
      'Seu principal objetivo agora deve ser se tornar um investidor regular: aquele que investe todos os meses, e não somente quando “o dinheiro do 13º sobra”.',
    ],
    introItens: 'Seu planejador tem um papel fundamental para:',
    itens: [
      'Te auxiliar na gestão cuidadosa dos seus gastos eventuais',
      'Ajudar a enxugar parte dos excessos para abrir espaço para investimentos recorrentes',
      'Estabelecer uma meta de investimento imediatamente, mesmo que ainda não seja o valor total necessário',
      'Se já houver dinheiro guardado, otimizar seus investimentos e focar na reserva de liquidez (segurança)',
    ],
    objetivo: 'Enxugar gastos e inserir metas mensais de investimento.',
  },
  7: {
    abertura: [
      'Seu orçamento é superavitário e só excede quando você inclui a sua meta mensal de investimento: você paga todas as contas e ainda sobra dinheiro, mas não o suficiente para realizar todos os objetivos planejados.',
      'Você está no caminho certo, e agora o principal objetivo é rever suas prioridades, no presente e no futuro. Assim você encontra mais espaço no orçamento atual e investe exatamente no que é mais importante para você.',
    ],
    introItens: 'Peça auxílio ao seu planejador para:',
    itens: [
      'Definir prioridades nos seus objetivos (itens, prazos e valores) para enxugar sua meta de investimento mensal',
      'Revisar os gastos para abrir um pouco mais de espaço',
      'Te ensinar sobre investimentos, suitability e alocação de carteira',
      'Começar com quantias progressivas de investimento até atingir o nível 9',
    ],
    objetivo: 'Rever suas prioridades, nos projetos futuros (prazos e valores) e no orçamento atual, para otimizar sua meta de investimento mensal.',
  },
  8: {
    abertura: [
      'Estar no nível 8 significa que, mesmo incluindo todos os seus sonhos, com prazos e valores, ainda sobra espaço no orçamento.',
      'Talvez seja hora de compreender o papel do dinheiro: trazer qualidade de vida no presente e no futuro (seus sonhos). Seu objetivo agora pode ser “sonhar e gastar mais”, até atingir o nível mínimo de sobras. Você gasta tempo de vida para ganhar seu dinheiro: honre esse tempo aproveitando tudo o que seus recursos podem oferecer.',
    ],
    introItens: 'Seu planejador será fundamental para:',
    itens: [
      'Incluir novos projetos e sonhos, reduzir prazos de realização e aumentar os valores desses objetivos',
      'Encontrar novas formas de gastar no presente que tragam mais satisfação e qualidade de vida',
      'Buscar alternativas inteligentes de investimento, com um pouco mais de risco para uma perspectiva de retorno maior',
      'Estudar a antecipação de projetos, como a sucessão',
    ],
    objetivo: 'Aumentar sua meta de investimento mensal ou os gastos que te trazem prazer no presente.',
  },
  9: {
    abertura: [
      'Você tem o que chamamos de Orçamento de Alta Performance (OAP). O nível 9 é o objetivo de qualquer trabalho sério de planejamento financeiro, pois sua execução mensal maximiza a qualidade de vida presente e futura.',
      'Parabéns! Seus gastos e metas de investimento estão 100% contemplados no orçamento. Para investir e realizar seus objetivos, basta executar todo mês o orçamento estimado e, claro, aprender a investir.',
    ],
    introItens: 'Peça auxílio ao seu planejador para:',
    itens: [
      'Te ensinar sobre investimentos, suitability e alocação de carteira',
      'Acompanhar de perto a execução mensal do orçamento, para garantir que você invista o valor integral',
      'Garantir que você execute mensalmente o seu Fluxo do Dinheiro',
      'Fazer a alocação mensal dos seus investimentos',
    ],
    objetivo: 'Executar todos os meses o Fluxo do Dinheiro.',
  },
};

function tom(nivel: number): { nivel: NivelComprometimento; rotulo: string } {
  if (nivel <= 3) return { nivel: 'elevado', rotulo: 'Ruim' };
  if (nivel <= 6) return { nivel: 'moderado', rotulo: 'Regular' };
  return { nivel: 'saudavel', rotulo: 'Ótimo' };
}

export function diagnosticoSaude(nivel: number | null): Diagnostico | null {
  if (nivel == null || !TEXTOS[nivel]) return null;
  const t = tom(nivel);
  return {
    ...TEXTOS[nivel],
    nivel: t.nivel,
    rotuloNivel: `Nível ${nivel} · ${t.rotulo}`,
    fechamento: [],
  };
}
