// Vídeos de instrução de cada página, pelo primeiro trecho da rota (ex.: /gastos → 'gastos').
// Cole o link do YouTube (watch?v=, youtu.be/ ou shorts/); o vídeo deve estar como "Não listado".
// Cada página tem um vídeo principal e, se quiser, subvídeos: com subvídeos, o painel da direita
// lista os títulos e o clique troca o vídeo. Link vazio mostra "Vídeo em breve".
// Uma página pode ter mais de um vídeo de nível 1: os grupos de "outros" vêm na lista logo abaixo do principal.
// "chamada" põe um botão no pé do painel que abre um link em nova aba (ex.: página de venda de um curso).

export interface VideoEtapa {
  titulo: string;
  link: string;
}
export interface GrupoVideos {
  principal: VideoEtapa;
  subvideos?: VideoEtapa[];
}
export interface ChamadaPainel {
  texto: string;
  link: string; // vazio = botão inativo
}
export interface VideosPagina extends GrupoVideos {
  outros?: GrupoVideos[];
  chamada?: ChamadaPainel;
}

// Vídeo de teste, igual em todas as páginas até os vídeos definitivos ficarem prontos.
const VIDEO_TESTE = 'https://www.youtube.com/watch?v=nLd6h5td8G4';
const teste = (titulo: string): VideoEtapa => ({ titulo, link: VIDEO_TESTE });

export const VIDEOS_ETAPAS: Record<string, VideosPagina> = {
  dashboard: {
    principal: teste('Dashboard'),
    subvideos: [
      teste('Jarro do Orçamento'),
      teste('Base de Plena Liquidez'),
      teste('Limite da Fatura do Cartão'),
      teste('Grau de Comprometimento do Orçamento'),
      teste('Nível de Saúde do Orçamento Familiar'),
    ],
  },
  recebimentos: {
    principal: teste('Recebimentos'),
    subvideos: [teste('Receitas Mensais'), teste('Receitas Eventuais')],
  },
  gastos: {
    principal: teste('Gastos'),
    // Categorias na ordem das abas; as abas de pessoa (nome de quem está cadastrado) viram "Gastos Pessoais"
    subvideos: [
      teste('Classificação dos Gastos'),
      teste('Moradia'),
      teste('Transporte'),
      teste('Vida e Saúde'),
      teste('Lazer'),
      teste('Alimentação FDC'),
      teste('Assinaturas'),
      teste('Gastos Pessoais'),
      teste('Dependentes'),
      teste('Empresa'),
    ],
  },
  'gestao-gastos': {
    principal: teste('Gestão de Pagamentos'),
    subvideos: [
      teste('Lançamento de Gastos'),
      teste('Em suspenso'),
      teste('Importar Fatura ou Extrato'),
      teste('Visão dos Parcelados'),
      teste('No vermelho! Como resolvo?'),
      teste('Estratégias para Enxugar Gastos'),
      teste('Ajustando a Estimativa para Realidade'),
    ],
  },
  dividas: {
    principal: teste('Dívida'),
    subvideos: [teste('Simulador de Taxas e Financiamentos'), teste('Como sair das dívidas?')],
    // Página de venda do curso de quitação de dívidas
    chamada: { texto: 'Me livrar das dívidas', link: '' },
  },
  'ativos-passivos': {
    principal: teste('Ativos & Passivos'),
    // Um vídeo por aba, na ordem das abas
    subvideos: [
      teste('Ativos Imobilizados'),
      teste('Ativos Financeiros'),
      teste('Passivos Imobilizados'),
      teste('Passivos Financeiros'),
    ],
  },
  sonhos: {
    principal: teste('Sonhos e Objetivos'),
    // Um vídeo por aba do Simulador de Projetos, na ordem das abas
    subvideos: [
      teste('Aposentadoria'),
      teste('Imóvel'),
      teste('Carro'),
      teste('Viagem'),
      teste('Novo Filho'),
      teste('Faculdade'),
    ],
    outros: [
      {
        principal: teste('Aprendendo a Investir'),
        subvideos: [
          teste('Investimento por Objetivos'),
          teste('O que é uma meta de investimento mensal'),
          teste('Como aumentar sua rentabilidade?'),
        ],
      },
    ],
    // Página de venda do curso de investimentos
    chamada: { texto: 'Quero aprender a investir', link: '' },
  },
  alertas: {
    principal: teste('Alertas'),
    subvideos: [teste('Lançando gastos pelo WhatsApp'), teste('Perguntando ao Zevem')],
  },
  configuracoes: {
    principal: teste('Configurações'),
    subvideos: [teste('Cadastrar Usuário'), teste('Cadastrar Cartões')],
  },
};

// Extrai o ID de 11 caracteres de um link do YouTube; null se não reconhecer.
export function idYoutube(link: string | undefined): string | null {
  if (!link) return null;
  const m = link.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}
