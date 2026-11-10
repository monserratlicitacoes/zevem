// Diagnóstico do grau de comprometimento do orçamento, mostrado no verso do velocímetro.
//   acima de 60  → elevado
//   abaixo de 40 → saudável
//   de 40 a 60   → moderado
// Nos textos, {v} é trocado pelo valor do indicador (sai em destaque).

export type NivelComprometimento = 'elevado' | 'moderado' | 'saudavel';

export interface Diagnostico {
  nivel: NivelComprometimento;
  rotuloNivel: string;
  chamada?: string;       // frase em destaque no topo (ex.: "PARABÉNS!")
  abertura: string[];
  introItens: string;
  itens: string[];
  fechamento: string[];
  frase?: string;         // frase final em destaque
  objetivo?: string;      // quadro "Objetivo" ao final
}

export function nivelComprometimento(valor: number): NivelComprometimento {
  if (valor > 60) return 'elevado';
  if (valor < 40) return 'saudavel';
  return 'moderado';
}

const TEXTOS: Record<NivelComprometimento, Diagnostico> = {
  elevado: {
    nivel: 'elevado',
    rotuloNivel: 'Elevado',
    abertura: [
      'Seu grau de comprometimento está em {v}: um nível elevado.',
      'Quase toda a sua renda já vai para despesas fixas e dívidas. Sobra pouca margem para escolhas, lazer, investimentos e imprevistos, e a sensação de viver para pagar boletos pesa na qualidade de vida.',
    ],
    introItens: 'Vale revisar:',
    itens: ['Gastos fixos', 'Dívidas', 'Contratos recorrentes', 'Formas de aumentar a renda'],
    fechamento: [
      'Com seu Planejador Financeiro, dá para montar um plano que reduza esse índice aos poucos e devolva sua capacidade de escolha.',
    ],
    frase: 'Vida financeira saudável não é só pagar contas. É ter liberdade.',
  },
  moderado: {
    nivel: 'moderado',
    rotuloNivel: 'Moderado',
    abertura: [
      'Seu grau de comprometimento está em {v}: um nível moderado.',
      'Ainda há margem, mas boa parte da renda já está comprometida: sobra pouco para poupar, você depende muito da renda ativa e imprevistos pesam.',
      'É a hora certa de ajustar, antes que o índice avance.',
    ],
    introItens: 'Com seu planejador, busque:',
    itens: ['Ajustar gastos comprometidos', 'Rever o padrão de vida', 'Tratar dívidas e parcelamentos'],
    fechamento: [
      'Pequenos ajustes já trazem mais tranquilidade com a renda atual.',
    ],
  },
  saudavel: {
    nivel: 'saudavel',
    rotuloNivel: 'Saudável',
    chamada: 'PARABÉNS!',
    abertura: [
      'Seu grau de comprometimento está em {v}: um nível saudável.',
    ],
    introItens: 'Sua renda está equilibrada e preserva margem para:',
    itens: ['Investir', 'Formar patrimônio', 'Decidir com flexibilidade', 'Ajustar sem perder padrão de vida'],
    fechamento: [
      'Talvez ainda não dê para fazer tudo o que gostaria, mas você tem flexibilidade para abrir espaço e investir mais.',
      'Próximo passo: transformar esse equilíbrio em estratégia para acelerar patrimônio, projetos e sonhos, com a ajuda do seu Planejador Financeiro.',
    ],
  },
};

export function diagnosticoComprometimento(valor: number): Diagnostico {
  return TEXTOS[nivelComprometimento(valor)];
}
