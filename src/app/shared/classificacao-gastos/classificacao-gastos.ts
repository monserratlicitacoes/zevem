import { Component, HostListener, computed, input, output } from '@angular/core';

// Fluxograma da classificação (gastos ou recebimentos), aberto como modal (material de consulta).
// Duas perguntas: acontece TODO mês? (Mensal / Eventual) e tem data FIXA? (Comprometido / Flexível).
// As cores das classes são as mesmas do gráfico de orçamento do Dashboard.
interface Classe {
  nome: string;
  resumo: string;
  cor: string;
  exemplos: string[];
}

interface Conteudo {
  titulo: string;
  pergunta1: string; // trecho antes de "TODO mês"
  pergunta2: string; // trecho depois de "data FIXA"
  exemplos: [string[], string[], string[], string[]]; // na ordem de CLASSES
  dica: { titulo: string; comprometido: string; flexivel: string };
}

const CLASSES = [
  { nome: 'Mensal Comprometido', resumo: 'Todo mês, com data fixa', cor: '#05261a' },
  { nome: 'Mensal Flexível', resumo: 'Todo mês, sem data fixa', cor: '#0b3d2e' },
  { nome: 'Eventual Comprometido', resumo: 'Não é todo mês, com data fixa', cor: '#7fa88f' },
  { nome: 'Eventual Flexível', resumo: 'Não é todo mês, sem data fixa', cor: '#39d353' },
];

const CONTEUDO: Record<'gastos' | 'recebimentos', Conteudo> = {
  gastos: {
    titulo: 'Como classificar seus gastos',
    pergunta1: 'Você tem esse gasto',
    pergunta2: 'para pagar',
    exemplos: [
      ['Aluguel', 'Condomínio', 'Plano de saúde', 'Escola / faculdade', 'Internet e celular', 'Streaming (Netflix, Spotify)'],
      ['Supermercado', 'Combustível', 'Farmácia', 'Restaurantes e delivery', 'Salão / barbearia'],
      ['IPTU', 'IPVA', 'Licenciamento do carro', 'Matrícula escolar', 'Anuidade do cartão'],
      ['Roupas e calçados', 'Presentes', 'Viagens', 'Manutenção da casa', 'Troca de celular'],
    ],
    dica: {
      titulo: 'Na dúvida sobre a data fixa:',
      comprometido: 'se tem boleto com vencimento, débito automático ou multa por atraso, é',
      flexivel: 'Se você decide quando e quanto gastar, é',
    },
  },
  recebimentos: {
    titulo: 'Como classificar seus recebimentos',
    pergunta1: 'Você recebe esse valor',
    pergunta2: 'para receber',
    exemplos: [
      ['Salário (CLT)', 'Pró-labore', 'Aposentadoria / pensão do INSS', 'Aluguel de imóvel', 'Pensão alimentícia'],
      ['Comissões', 'Corridas e entregas por aplicativo', 'Atendimentos de autônomo', 'Vendas do mês', 'Gorjetas'],
      ['13º salário', 'Férias (adicional de 1/3)', 'PLR / participação nos lucros', 'Bônus anual'],
      ['Restituição do Imposto de Renda', 'Venda de bens usados', 'Trabalhos avulsos (freelas)', 'Presentes em dinheiro', 'Prêmios'],
    ],
    dica: {
      titulo: 'Na dúvida sobre a data fixa:',
      comprometido: 'se quem paga tem um dia certo para depositar (empresa, contrato, INSS), é',
      flexivel: 'Se depende de vendas, clientes ou do seu trabalho no mês, é',
    },
  },
};

@Component({
  selector: 'app-classificacao-gastos',
  imports: [],
  templateUrl: './classificacao-gastos.html',
  styleUrl: './classificacao-gastos.scss',
})
export class ClassificacaoGastos {
  tipo = input<'gastos' | 'recebimentos'>('gastos');
  fechar = output<void>();

  conteudo = computed(() => CONTEUDO[this.tipo()]);
  classes = computed<Classe[]>(() => CLASSES.map((c, i) => ({ ...c, exemplos: this.conteudo().exemplos[i] })));

  // Ramos da 1ª pergunta, cada um com as classes da 2ª (Sim = Comprometido, Não = Flexível)
  ramos = computed(() => [
    { resp: 'Sim', tipo: 'Mensal', desc: 'acontece todo mês', classes: this.classes().slice(0, 2) },
    { resp: 'Não', tipo: 'Eventual', desc: 'não acontece todo mês', classes: this.classes().slice(2, 4) },
  ]);

  @HostListener('document:keydown.escape')
  aoEsc() { this.fechar.emit(); }
}
