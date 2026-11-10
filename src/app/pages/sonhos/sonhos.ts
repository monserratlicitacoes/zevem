import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { MascaraMoeda } from '../../shared/mascara-moeda';
import { mimSonho, mesesRestantesSonho, parseDataSonho } from '../../shared/calculo-sonhos';
import { VideoBadge } from '../../shared/video-badge/video-badge';
import { JarroOrcamento } from '../../shared/jarro-orcamento/jarro-orcamento';

interface Sonho {
  id: number;
  nome: string;
  descricao: string;
  valor_total: number | null;
  prazo: number;
  rentabilidade: number;
  valor_inicial: number | null;
  data_inicio: string;
  valor_selado: number | null;
}

@Component({
  selector: 'app-sonhos',
  standalone: true,
  imports: [CommonModule, FormsModule, MascaraMoeda, VideoBadge, JarroOrcamento],
  templateUrl: './sonhos.html',
  styleUrl: './sonhos.scss',
})
export class Sonhos implements OnInit {
  jarroAberto = false; // modal "Jarro do Orçamento"
  private api = `${environment.apiUrl}/sonhos`;
  sonhos: Sonho[] = [];
  carregando = false;
  adicionando = false;
  private tempId = -1;

  modalAberto = false;
  simuladorAberto = false;
  abaSimulador: 'aposentadoria' | 'imovel' | 'carro' | 'viagem' | 'filho' | 'faculdade' = 'aposentadoria';

  // ── Simulador Aposentadoria (só os campos; a regra de cálculo vem depois) ──
  simAposentadoria = {
    idades: [] as (number | null)[],          // idade desejada para aposentar, uma por pessoa cadastrada
    rentabilidadeAm: 1 as number | null,      // rentabilidade de derivação, % a.m.
    rendaAlugueis: null as number | null,     // renda que já tem hoje em aluguéis (R$/mês)
    rendaInss: null as number | null,         // renda prevista no INSS (R$/mês)
    considerarEventual: false,
    formatoRenda: 'perene' as 'perene' | 'estoque',
    idadeMorte: null as number | null,        // só quando consumo de estoque
    metodoRenda: 'receita' as 'receita' | 'despesas' | 'livre',
    rendaLivre: null as number | null,        // só quando método livre
    inflacaoAa: null as number | null,        // inflação futura considerada, % a.a.
  };
  aposPessoas: { nome: string; idadeAtual: number | null }[] = [];
  aposRendaAtual: number | null = null;     // recebimentos Mensal Flexível + Mensal Comprometido
  aposRendaEventual: number | null = null;  // recebimentos eventuais mensalizados (valor anual / 12)
  aposDespesaAtual: number | null = null;   // metas mensais de gastos (eventuais /12), sem Dependentes
  private aposPessoasCarregadas = false;

  abrirSimulador() {
    this.simuladorAberto = true;
    this.carregarPessoasAposentadoria();
  }

  carregarPessoasAposentadoria() {
    if (this.aposPessoasCarregadas) return;
    this.aposPessoasCarregadas = true;
    this.http.get<any[]>(`${environment.apiUrl}/pessoas`).subscribe({
      next: (pessoas) => this.naTela(() => {
        this.aposPessoas = pessoas.slice(0, 2).map(p => ({ nome: p.nome, idadeAtual: this.idadeHoje(p.data_nascimento) }));
        this.simAposentadoria.idades = this.aposPessoas.map((_, i) => this.simAposentadoria.idades[i] ?? null);
        this.cdr.detectChanges();
      }),
      error: () => { this.aposPessoasCarregadas = false; },
    });
    this.http.get<any[]>(`${environment.apiUrl}/recebimentos`).subscribe({
      next: (recs) => this.naTela(() => {
        const mensais = recs.filter(r => r.classe === 'Mensal Flexível' || r.classe === 'Mensal Comprometido');
        this.aposRendaAtual = Math.round(mensais.reduce((t, r) => t + (Number(r.valor) || 0), 0) * 100) / 100;
        const eventuais = recs.filter(r => String(r.classe).startsWith('Eventual'));
        this.aposRendaEventual = Math.round(eventuais.reduce((t, r) => t + (Number(r.valor) || 0) / 12, 0) * 100) / 100;
        this.cdr.detectChanges();
      }),
    });
    this.http.get<any[]>(`${environment.apiUrl}/gastos`).subscribe({
      next: (gastos) => this.naTela(() => {
        const semDependentes = gastos.filter(g => g.categoria !== 'dependentes');
        this.aposDespesaAtual = Math.round(semDependentes.reduce((t, g) => t + (Number(g.valor_mensal) || 0), 0) * 100) / 100;
        this.cdr.detectChanges();
      }),
    });
  }

  // ── Cálculo do patrimônio necessário ──
  // Tudo em valores de hoje: a rentabilidade de derivação é descontada da inflação mensal
  // (taxa real = (1 + r) / (1 + inflação mensal) − 1). A renda a gerar pelo patrimônio é a renda
  // necessária menos o que já é garantido (aluguéis + INSS).
  //  • Fluxo perene: só os rendimentos pagam a renda → patrimônio = renda / taxa real.
  //  • Consumo de estoque: rendimentos + o próprio principal pagam a renda, zerando na idade de morte
  //    → patrimônio = renda × (1 − (1 + i)^−n) / i, com n = meses entre a aposentadoria e a morte.
  //    No casal, conta da primeira aposentadoria até a idade de morte da pessoa mais nova.
  get resultadoAposentadoria(): {
    rendaNecessaria: number; rendaGarantida: number; rendaAGerar: number;
    taxaRealAm: number; meses: number | null; patrimonio: number | null; erro: string | null;
  } | null {
    const a = this.simAposentadoria;
    const rendaNecessaria = this.aposRendaNecessaria;
    if (rendaNecessaria === null || a.rentabilidadeAm === null) return null;
    const rendaGarantida = (a.rendaAlugueis ?? 0) + (a.rendaInss ?? 0);
    const rendaAGerar = Math.max(0, rendaNecessaria - rendaGarantida);
    const r = a.rentabilidadeAm / 100;
    const infMes = Math.pow(1 + (a.inflacaoAa ?? 0) / 100, 1 / 12) - 1;
    const i = (1 + r) / (1 + infMes) - 1;
    const base = { rendaNecessaria, rendaGarantida, rendaAGerar, taxaRealAm: i * 100, meses: null as number | null, patrimonio: null as number | null, erro: null as string | null };

    if (rendaAGerar === 0) return { ...base, patrimonio: 0 };

    if (a.formatoRenda === 'perene') {
      if (i <= 0) return { ...base, erro: 'A rentabilidade precisa ser maior que a inflação para gerar renda perene.' };
      return { ...base, patrimonio: rendaAGerar / i };
    }

    const meses = this.aposMesesConsumo();
    if (meses === null) return { ...base, erro: 'Informe a idade na aposentadoria e a idade estimada na morte.' };
    if (meses <= 0) return { ...base, erro: 'A idade estimada na morte precisa ser maior que a idade na aposentadoria.' };
    const patrimonio = Math.abs(i) < 1e-12 ? rendaAGerar * meses : rendaAGerar * (1 - Math.pow(1 + i, -meses)) / i;
    return { ...base, meses, patrimonio };
  }

  // Aporte mensal para chegar ao patrimônio na data da aposentadoria, de hoje até lá.
  // A inflação só é descontada na derivação (patrimônio necessário); na acumulação vale a
  // rentabilidade informada, sem desconto. Aportes no fim de cada mês: PMT = patrimônio × i / ((1 + i)^n − 1).
  get aposAporteMensal(): { meses: number; valor: number; dataAposentadoria: Date; taxaAm: number } | { erro: string } | null {
    const res = this.resultadoAposentadoria;
    if (!res || res.erro || res.patrimonio === null) return null;
    const a = this.simAposentadoria;
    const comIdade = this.aposPessoas.filter((_, k) => !!a.idades[k]);
    if (this.aposPessoas.length && !comIdade.length) return { erro: 'Informe a idade na aposentadoria para calcular o investimento mensal.' };
    const n = this.aposMesesAteAposentadoria();
    if (n === null) return { erro: 'Cadastre a data de nascimento em Configurações para calcular o investimento mensal até a aposentadoria.' };
    if (n <= 0) return { erro: 'A idade na aposentadoria já foi atingida: não há prazo para acumular.' };
    const taxaAm = a.rentabilidadeAm ?? 0;
    const i = taxaAm / 100;
    const valor = Math.abs(i) < 1e-12 ? res.patrimonio / n : res.patrimonio * i / (Math.pow(1 + i, n) - 1);
    const d = new Date();
    return { meses: n, valor, dataAposentadoria: new Date(d.getFullYear(), d.getMonth() + n, 1), taxaAm };
  }

  // Meses de hoje até a primeira aposentadoria (no casal, quem se aposenta antes).
  private aposMesesAteAposentadoria(): number | null {
    const a = this.simAposentadoria;
    const prazos: number[] = [];
    this.aposPessoas.forEach((p, k) => {
      if (a.idades[k] && p.idadeAtual !== null) prazos.push((a.idades[k]! - p.idadeAtual) * 12);
    });
    return prazos.length ? Math.min(...prazos) : null;
  }

  fmtMesAno(d: Date): string {
    const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    return `${meses[d.getMonth()]}/${d.getFullYear()}`;
  }

  aposAporteOk(x: any): x is { meses: number; valor: number; dataAposentadoria: Date; taxaAm: number } { return !!x && !('erro' in x); }

  // Meses de consumo do patrimônio (da primeira aposentadoria até a morte da pessoa mais nova).
  private aposMesesConsumo(): number | null {
    const a = this.simAposentadoria;
    if (!a.idadeMorte) return null;
    const pessoas = this.aposPessoas.length ? this.aposPessoas : [{ nome: '', idadeAtual: null }];
    const inicios: number[] = [];
    const fins: number[] = [];
    pessoas.forEach((p, k) => {
      const idadeApos = a.idades[k];
      if (!idadeApos) return;
      const atual = p.idadeAtual ?? idadeApos; // sem idade atual, mede a partir da própria aposentadoria
      inicios.push((idadeApos - atual) * 12);
      fins.push((a.idadeMorte! - atual) * 12);
    });
    if (!inicios.length) return null;
    return Math.max(...fins) - Math.min(...inicios);
  }

  // Renda mensal que o cliente quer na aposentadoria, conforme o método escolhido.
  get aposRendaNecessaria(): number | null {
    const a = this.simAposentadoria;
    if (a.metodoRenda === 'receita') {
      if (this.aposRendaAtual === null) return null;
      // Com "Considerar receita eventual", a receita eventual mensalizada entra na receita atual.
      const eventual = a.considerarEventual ? (this.aposRendaEventual ?? 0) : 0;
      return Math.round((this.aposRendaAtual + eventual) * 100) / 100;
    }
    if (a.metodoRenda === 'despesas') return this.aposDespesaAtual;
    return a.rendaLivre;
  }

  get aposCasal(): boolean { return this.aposPessoas.length > 1; }

  private idadeHoje(nasc: string | null | undefined): number | null {
    if (!nasc) return null;
    const d = new Date(nasc + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const hoje = new Date();
    let idade = hoje.getFullYear() - d.getFullYear();
    if (hoje.getMonth() < d.getMonth() || (hoje.getMonth() === d.getMonth() && hoje.getDate() < d.getDate())) idade--;
    return idade;
  }

  fmtMoeda(v: number | null): string {
    return v === null || v === undefined ? '' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Percentual com vírgula e duas casas ("1,00"); o modelo guarda número.
  fmtPct(v: number | null): string {
    if (v === null || v === undefined) return '';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Texto digitado nos campos de percentual da aposentadoria. O número vai para o modelo a cada
  // tecla (o resultado recalcula na hora); ao sair do campo, o texto é reformatado ("4,5" → "4,50").
  aposPctTxt: Record<'rentabilidadeAm' | 'inflacaoAa', string> = { rentabilidadeAm: '1,00', inflacaoAa: '' };

  private lerPct(txt: string): number | null {
    let t = String(txt ?? '').replace(/[^\d,.-]/g, '');
    // Aceita "4,5", "4.5" e "1.234,5": com vírgula, ponto é milhar; sem vírgula, ponto é decimal.
    t = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  }

  onPctDigitado(campo: 'rentabilidadeAm' | 'inflacaoAa', txt: string) {
    this.aposPctTxt[campo] = txt;
    this.simAposentadoria[campo] = this.lerPct(txt);
  }

  onPctSaiu(campo: 'rentabilidadeAm' | 'inflacaoAa') {
    this.aposPctTxt[campo] = this.fmtPct(this.simAposentadoria[campo]);
  }

  // ── Simulador Carro ──────────────────────────────────────────
  private fipeBase = `${environment.apiUrl}/fipe`;

  simCarro = {
    valorNovo: null as number | null,
    meses: null as number | null,
    temCarroAtual: false,
    valorAtual: null as number | null,
    valorAtualEditado: null as number | null, // sobrescreve depreciação calculada
  };

  // Novo carro
  fipeMarcas: {codigo: string; nome: string}[] = [];
  fipeModelos: {codigo: number; nome: string}[] = [];
  fipeAnos: {codigo: string; nome: string}[] = [];
  fipeMarcaCod = '';
  fipeModeloCod = '';
  fipeBuscando = false;
  fipeCarregandoMarcas = false;
  fipeCarregandoModelos = false;
  fipeCarregandoAnos = false;
  fipeErro = '';

  // Carro atual
  fipeMarcasAt: {codigo: string; nome: string}[] = [];
  fipeModelosAt: {codigo: number; nome: string}[] = [];
  fipeAnosAt: {codigo: string; nome: string}[] = [];
  fipeMarcaCodAt = '';
  fipeModeloCodAt = '';
  fipeAnoAtSel = '';
  fipeCarregandoMarcasAt = false;
  fipeCarregandoModelosAt = false;
  fipeCarregandoAnosAt = false;

  carregarMarcas() {
    if (this.fipeMarcas.length) return;
    this.fipeCarregandoMarcas = true;
    this.http.get<{codigo: string; nome: string}[]>(`${this.fipeBase}/marcas`).subscribe({
      next: ms => this.naTela(() => { this.fipeMarcas = ms; this.fipeCarregandoMarcas = false; }),
      error: () => this.naTela(() => { this.fipeCarregandoMarcas = false; })
    });
  }

  onMarcaSel(codigo: string) {
    this.fipeMarcaCod = codigo; this.fipeModelos = []; this.fipeAnos = []; this.fipeModeloCod = ''; this.simCarro.valorNovo = null;
    if (!codigo) return;
    this.fipeCarregandoModelos = true;
    this.http.get<{modelos: {codigo: number; nome: string}[]}>(`${this.fipeBase}/marcas/${codigo}/modelos`).subscribe({
      next: r => this.naTela(() => { this.fipeModelos = r.modelos; this.fipeCarregandoModelos = false; }),
      error: () => this.naTela(() => { this.fipeCarregandoModelos = false; })
    });
  }

  onModeloSel(codigo: string) {
    this.fipeModeloCod = codigo; this.fipeAnos = []; this.simCarro.valorNovo = null;
    if (!codigo) return;
    this.fipeCarregandoAnos = true;
    this.http.get<{codigo: string; nome: string}[]>(`${this.fipeBase}/marcas/${this.fipeMarcaCod}/modelos/${codigo}/anos`).subscribe({
      next: anos => this.naTela(() => {
        this.fipeAnos = anos.filter(a => !a.codigo.startsWith('32000'));
        if (!this.fipeAnos.length) this.fipeAnos = anos;
        this.fipeCarregandoAnos = false;
      }),
      error: () => this.naTela(() => { this.fipeCarregandoAnos = false; })
    });
  }

  onAnoSel(codigo: string) {
    if (!codigo) return;
    this.fipeBuscando = true; this.fipeErro = '';
    this.http.get<{Valor: string}>(`${this.fipeBase}/marcas/${this.fipeMarcaCod}/modelos/${this.fipeModeloCod}/anos/${codigo}`).subscribe({
      next: r => this.naTela(() => {
        const n = parseFloat(r.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
        this.simCarro.valorNovo = isNaN(n) ? null : n;
        this.fipeBuscando = false;
      }),
      error: () => this.naTela(() => { this.fipeErro = 'Erro ao buscar preço.'; this.fipeBuscando = false; })
    });
  }

  carregarMarcasAt() {
    if (this.fipeMarcasAt.length) return;
    if (this.fipeMarcas.length) { this.fipeMarcasAt = this.fipeMarcas; return; }
    this.fipeCarregandoMarcasAt = true;
    this.http.get<{codigo: string; nome: string}[]>(`${this.fipeBase}/marcas`).subscribe({
      next: ms => this.naTela(() => { this.fipeMarcasAt = ms; this.fipeCarregandoMarcasAt = false; }),
      error: () => this.naTela(() => { this.fipeCarregandoMarcasAt = false; })
    });
  }

  onMarcaAtSel(codigo: string) {
    this.fipeMarcaCodAt = codigo; this.fipeModelosAt = []; this.fipeAnosAt = []; this.fipeModeloCodAt = ''; this.simCarro.valorAtual = null;
    if (!codigo) return;
    this.fipeCarregandoModelosAt = true;
    this.http.get<{modelos: {codigo: number; nome: string}[]}>(`${this.fipeBase}/marcas/${codigo}/modelos`).subscribe({
      next: r => this.naTela(() => { this.fipeModelosAt = r.modelos; this.fipeCarregandoModelosAt = false; }),
      error: () => this.naTela(() => { this.fipeCarregandoModelosAt = false; })
    });
  }

  onModeloAtSel(codigo: string) {
    this.fipeModeloCodAt = codigo; this.fipeAnosAt = []; this.simCarro.valorAtual = null;
    if (!codigo) return;
    this.fipeCarregandoAnosAt = true;
    this.http.get<{codigo: string; nome: string}[]>(`${this.fipeBase}/marcas/${this.fipeMarcaCodAt}/modelos/${codigo}/anos`).subscribe({
      next: anos => this.naTela(() => {
        this.fipeAnosAt = anos.filter(a => !a.codigo.startsWith('32000'));
        if (!this.fipeAnosAt.length) this.fipeAnosAt = anos;
        this.fipeCarregandoAnosAt = false;
      }),
      error: () => this.naTela(() => { this.fipeCarregandoAnosAt = false; })
    });
  }

  onAnoAtSel(codigo: string) {
    if (!codigo) return;
    this.fipeAnoAtSel = codigo;
    this.http.get<{Valor: string}>(`${this.fipeBase}/marcas/${this.fipeMarcaCodAt}/modelos/${this.fipeModeloCodAt}/anos/${codigo}`).subscribe({
      next: r => this.naTela(() => {
        const n = parseFloat(r.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
        this.simCarro.valorAtual = isNaN(n) ? null : n;
        this.simCarro.valorAtualEditado = null;
      }),
      error: () => {},
    });
  }

  get valorCarroAtualDaqui(): number | null {
    const valor = this.simCarro.valorAtual;
    const meses = this.simCarro.meses;
    if (!valor || !meses || !this.fipeAnoAtSel) return null;

    // Extrai o ano do código FIPE, ex: "2020-1" → 2020
    const anoFabricacao = parseInt(this.fipeAnoAtSel.split('-')[0], 10);
    if (isNaN(anoFabricacao)) return null;

    const hoje = new Date();
    const idadeAtualMeses = (hoje.getFullYear() - anoFabricacao) * 12 + hoje.getMonth();

    // Projeta mês a mês aplicando a taxa correta para a idade do carro em cada mês
    let v = valor;
    for (let i = 0; i < meses; i++) {
      const idadeMes = idadeAtualMeses + i; // idade do carro naquele mês
      const anosCarro = idadeMes / 12;
      let taxa: number;
      if (anosCarro <= 2)      taxa = 0.008; // 0,8% ao mês — até 2 anos
      else if (anosCarro <= 5) taxa = 0.006; // 0,6% ao mês — 3º ao 5º ano
      else                     taxa = 0.004; // 0,4% ao mês — a partir do 6º ano
      v = v * (1 - taxa);
    }
    return Math.round(v);
  }

  // ── Simulador Imóvel ─────────────────────────────────────────
  simImovel = {
    valor: null as number | null,
    entradaPct: 20,
    meses: null as number | null,
    financiar: false,
    temReserva: false,
    reserva: null as number | null,
  };

  get resultadoImovel(): { valorMeta: number; entrada: number; valorNecessario: number } {
    const valorTotal = this.simImovel.valor ?? 0;
    const entrada = Math.round(valorTotal * (this.simImovel.entradaPct ?? 0) / 100);
    const valorMeta = this.simImovel.financiar ? entrada : valorTotal;
    const reserva = this.simImovel.temReserva ? (this.simImovel.reserva ?? 0) : 0;
    const valorNecessario = Math.max(0, valorMeta - reserva);
    return { valorMeta, entrada, valorNecessario };
  }

  // ── Simulador Viagem ─────────────────────────────────────────
  readonly destinosViagem = [
    { valor: 'brasil',         nome: 'Brasil',           voo: 800,  diaria: 350, passeios: 150, alimentacao: 200, transporte: 80,  compras: 200 },
    { valor: 'america-latina', nome: 'América Latina',   voo: 2500, diaria: 400, passeios: 200, alimentacao: 250, transporte: 100, compras: 300 },
    { valor: 'america-norte',  nome: 'América do Norte', voo: 5500, diaria: 900, passeios: 400, alimentacao: 500, transporte: 200, compras: 800 },
    { valor: 'europa',         nome: 'Europa',           voo: 7000, diaria: 950, passeios: 350, alimentacao: 450, transporte: 180, compras: 700 },
    { valor: 'africa',         nome: 'África',           voo: 8500, diaria: 750, passeios: 300, alimentacao: 350, transporte: 150, compras: 300 },
    { valor: 'asia',           nome: 'Ásia',             voo: 7500, diaria: 800, passeios: 280, alimentacao: 320, transporte: 120, compras: 600 },
  ];

  cambio = { usd: null as number | null, eur: null as number | null, carregando: false };

  buscarCambio() {
    if (this.cambio.usd || this.cambio.carregando) return;
    this.cambio.carregando = true;
    this.http.get<any>('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL').subscribe({
      next: (res) => this.naTela(() => {
        this.cambio.usd = parseFloat(res['USDBRL']?.bid ?? '0') || null;
        this.cambio.eur = parseFloat(res['EURBRL']?.bid ?? '0') || null;
        this.cambio.carregando = false;
      }),
      error: () => this.naTela(() => { this.cambio.carregando = false; }),
    });
  }

  simViagem = {
    destino: '',
    pessoas: 1,
    dias: null as number | null,
    meses: null as number | null,
    custoVoo: null as number | null,
    custoDiaria: null as number | null,
    custoPasseios: null as number | null,
    custoAlimentacao: null as number | null,
    custoTransporte: null as number | null,
    custoCompras: null as number | null,
  };

  onDestinoSel(valor: string) {
    const d = this.destinosViagem.find(x => x.valor === valor);
    if (d) {
      this.simViagem.destino = valor;
      this.simViagem.custoVoo = d.voo;
      this.simViagem.custoDiaria = d.diaria;
      this.simViagem.custoPasseios = d.passeios;
      this.simViagem.custoAlimentacao = d.alimentacao;
      this.simViagem.custoTransporte = d.transporte;
      this.simViagem.custoCompras = d.compras;
    } else {
      this.simViagem.destino = '';
    }
  }

  get resultadoViagem(): { totalVoo: number; totalDiaria: number; totalPasseios: number; totalAlimentacao: number; totalTransporte: number; totalCompras: number; total: number } {
    const p = this.simViagem.pessoas ?? 1;
    const d = this.simViagem.dias ?? 0;
    const totalVoo        = Math.round((this.simViagem.custoVoo ?? 0) * p);
    const totalDiaria     = Math.round((this.simViagem.custoDiaria ?? 0) * d * p);
    const totalPasseios   = Math.round((this.simViagem.custoPasseios ?? 0) * d * p);
    const totalAlimentacao= Math.round((this.simViagem.custoAlimentacao ?? 0) * d * p);
    const totalTransporte = Math.round((this.simViagem.custoTransporte ?? 0) * d * p);
    const totalCompras    = Math.round((this.simViagem.custoCompras ?? 0) * p);
    const total = totalVoo + totalDiaria + totalPasseios + totalAlimentacao + totalTransporte + totalCompras;
    return { totalVoo, totalDiaria, totalPasseios, totalAlimentacao, totalTransporte, totalCompras, total };
  }

  adicionarViagemAosSonhos() {
    const { total } = this.resultadoViagem;
    const meses = this.simViagem.meses ?? 12;
    const destino = this.destinosViagem.find(x => x.valor === this.simViagem.destino)?.nome ?? 'Viagem';
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    const tid = this.tempId--;
    const temp: Sonho = { id: tid, nome: `Viagem — ${destino}`, descricao: '', valor_total: total, prazo: meses, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.sonhos = [...this.sonhos, temp];
    this.simuladorAberto = false;
    this.cdr.detectChanges();
    const body = { nome: `Viagem — ${destino}`, descricao: '', valor_total: total, prazo: meses, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.http.post<Sonho>(this.api, body).subscribe({
      next: s => { this.sonhos = this.sonhos.map(x => x.id === tid ? s : x); this.cdr.detectChanges(); },
      error: () => { this.sonhos = this.sonhos.filter(x => x.id !== tid); this.cdr.detectChanges(); }
    });
  }

  // ── Novo Filho ──────────────────────────────────────────────
  simFilho = {
    mesesAteNascimento: null as number | null,
    custoEnxoval: null as number | null,
    mesesLicenca: 6,
    temInss: false,
    valorInss: null as number | null,
    rendaLicenca: null as number | null,
    pessoaLicencaIdx: '' as string,
  };

  filhoPessoas: { nome: string; nomeCurto: string }[] = [];
  private _filhoRecs: any[] = [];
  filhoRendaCarregada = false;

  carregarRendaFilho() {
    if (this.filhoRendaCarregada) return;
    this.filhoRendaCarregada = true;
    this.http.get<any[]>(`${environment.apiUrl}/recebimentos`).subscribe({
      next: (recs) => this.naTela(() => {
        this._filhoRecs = recs;
        const total = recs.reduce((s, r) => s + (r.valor_mensal ?? r.valor ?? 0), 0);
        this.simFilho.custoEnxoval = Math.round(total);
        this.http.get<any[]>(`${environment.apiUrl}/pessoas`).subscribe({
          next: (pessoas) => this.naTela(() => {
            this.filhoPessoas = pessoas.map(p => ({ nome: p.nome, nomeCurto: p.nome.trim().split(/\s+/)[0] }));
            this.cdr.detectChanges();
          }),
        });
        this.cdr.detectChanges();
      }),
    });
  }

  onPessoaLicencaSel(idx: string) {
    this.simFilho.pessoaLicencaIdx = idx;
    const p = this.filhoPessoas[+idx];
    if (!p) return;
    const renda = this._filhoRecs.filter(r => r.origem === p.nomeCurto).reduce((s, r) => s + (r.valor_mensal ?? r.valor ?? 0), 0);
    this.simFilho.rendaLicenca = Math.round(renda) || null;
    this.cdr.detectChanges();
  }

  get resultadoFilho(): { totalEnxoval: number; totalLicenca: number; total: number } | null {
    const { mesesAteNascimento, custoEnxoval, mesesLicenca, temInss, valorInss, rendaLicenca } = this.simFilho;
    if (!mesesAteNascimento || !custoEnxoval) return null;
    const rendaLiq = (rendaLicenca ?? 0) - (temInss ? (valorInss ?? 0) : 0);
    const totalLicenca = Math.round(Math.max(0, rendaLiq) * mesesLicenca);
    return { totalEnxoval: custoEnxoval, totalLicenca, total: custoEnxoval + totalLicenca };
  }

  adicionarFilhoAosSonhos() {
    const res = this.resultadoFilho;
    if (!res) return;
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    const prazo = this.simFilho.mesesAteNascimento ?? 9;
    const tid = this.tempId--;
    const temp: Sonho = { id: tid, nome: 'Novo Filho', descricao: '', valor_total: res.total, prazo, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.sonhos = [...this.sonhos, temp];
    this.simuladorAberto = false;
    this.cdr.detectChanges();
    const body = { nome: 'Novo Filho', descricao: '', valor_total: res.total, prazo, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.http.post<Sonho>(this.api, body).subscribe({
      next: s => { this.sonhos = this.sonhos.map(x => x.id === tid ? s : x); this.cdr.detectChanges(); },
      error: () => { this.sonhos = this.sonhos.filter(x => x.id !== tid); this.cdr.detectChanges(); }
    });
  }

  readonly tiposFaculdade = [
    { valor: 'publica',     nome: 'Pública (gratuita)',      mensalidade: 0,    moradia: 2000 },
    { valor: 'particular',  nome: 'Particular presencial',   mensalidade: 2500, moradia: 2200 },
    { valor: 'ead',         nome: 'EAD',                     mensalidade: 600,  moradia: 2200 },
  ];

  private _novoFilho() {
    return { nome: '', idadeFilho: null as number | null, duracaoCurso: 4, tipo: '' as ''|'publica'|'particular'|'ead', morarFora: false, custoMensalidade: null as number | null, custoMoradia: null as number | null };
  }

  filhosFaculdade = [ this._novoFilho() ];

  adicionarFilho() { this.filhosFaculdade = [...this.filhosFaculdade, this._novoFilho()]; }
  removerFilho(i: number) { this.filhosFaculdade = this.filhosFaculdade.filter((_, idx) => idx !== i); }

  onTipoFilhoSel(i: number, valor: string) {
    const t = this.tiposFaculdade.find(x => x.valor === valor);
    if (t) { this.filhosFaculdade[i].tipo = valor as any; this.filhosFaculdade[i].custoMensalidade = t.mensalidade; this.filhosFaculdade[i].custoMoradia = t.moradia; }
  }

  calcFilho(f: ReturnType<Sonhos['_novoFilho']>) {
    if (f.idadeFilho === null || !f.duracaoCurso || !f.tipo) return null;
    const anosAteIniciar = Math.max(0, 18 - f.idadeFilho);
    const fatorCorrecao = Math.pow(1.04, anosAteIniciar);
    const mesesCurso = f.duracaoCurso * 12;
    const totalMensalidades = Math.round((f.custoMensalidade ?? 0) * fatorCorrecao * mesesCurso);
    const totalMoradia      = f.morarFora ? Math.round((f.custoMoradia ?? 0) * fatorCorrecao * mesesCurso) : 0;
    return { anosAteIniciar, prazoMeses: anosAteIniciar * 12, fatorCorrecao, totalMensalidades, totalMoradia, total: totalMensalidades + totalMoradia };
  }

  get resultadosFaculdade() {
    const res = this.filhosFaculdade.map(f => this.calcFilho(f));
    return { itens: res, total: res.reduce((s, r) => s + (r?.total ?? 0), 0), temAlgum: res.some(r => r !== null) };
  }

  adicionarFaculdadeAosSonhos() {
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    this.filhosFaculdade.forEach((f, i) => {
      const res = this.calcFilho(f);  // already computed, call once per child
      if (!res) return;
      const label = f.nome?.trim() ? `Faculdade — ${f.nome}` : `Faculdade — Filho ${i + 1}`;
      const prazo = res.prazoMeses || 12;
      const tid = this.tempId--;
      const temp: Sonho = { id: tid, nome: label, descricao: '', valor_total: res.total, prazo, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
      this.sonhos = [...this.sonhos, temp];
      const body = { nome: label, descricao: '', valor_total: res.total, prazo, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
      this.http.post<Sonho>(this.api, body).subscribe({
        next: s => { this.sonhos = this.sonhos.map(x => x.id === tid ? s : x); this.cdr.detectChanges(); },
        error: () => { this.sonhos = this.sonhos.filter(x => x.id !== tid); this.cdr.detectChanges(); }
      });
    });
    this.simuladorAberto = false;
    this.cdr.detectChanges();
  }

  // Leva a aposentadoria para a grade: meta = patrimônio necessário, prazo = meses até a aposentadoria
  // e rentabilidade = a da acumulação, sem desconto da inflação (para o M.I.M. da grade bater com o aporte).
  adicionarAposentadoriaAosSonhos() {
    const res = this.resultadoAposentadoria;
    const ap = this.aposAporteMensal;
    if (!res || res.patrimonio === null || !this.aposAporteOk(ap)) return;
    const a = this.simAposentadoria;
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    const formato = a.formatoRenda === 'perene' ? 'Fluxo perene' : `Consumo de estoque até ${a.idadeMorte} anos`;
    const inflacao = a.inflacaoAa ? ` − inflação ${this.fmtPct(a.inflacaoAa)}% a.a.` : '';
    const descricao = `${formato} · renda de R$ ${this.fmtMoeda(res.rendaAGerar)}/mês · ${this.fmtPct(a.rentabilidadeAm)}% a.m.${inflacao}`;
    const body = {
      nome: 'Aposentadoria', descricao,
      valor_total: Math.round(res.patrimonio * 100) / 100,
      prazo: ap.meses,
      rentabilidade: ap.taxaAm,
      valor_inicial: null, data_inicio: dataInicio, valor_selado: null,
    };
    const tid = this.tempId--;
    this.sonhos = [...this.sonhos, { id: tid, ...body } as Sonho];
    this.simuladorAberto = false;
    this.cdr.detectChanges();
    this.http.post<Sonho>(this.api, body).subscribe({
      next: s => { this.sonhos = this.sonhos.map(x => x.id === tid ? s : x); this.cdr.detectChanges(); },
      error: () => { this.sonhos = this.sonhos.filter(x => x.id !== tid); this.cdr.detectChanges(); }
    });
  }

  adicionarImovelAosSonhos() {
    const meses = this.simImovel.meses ?? 12;
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    const tid = this.tempId--;
    const reserva = this.simImovel.temReserva ? (this.simImovel.reserva ?? null) : null;
    const temp: Sonho = { id: tid, nome: 'Imóvel', descricao: '', valor_total: this.resultadoImovel.valorMeta, prazo: meses, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: reserva };
    this.sonhos = [...this.sonhos, temp];
    this.simuladorAberto = false;
    this.cdr.detectChanges();
    const body = { nome: 'Imóvel', descricao: '', valor_total: this.resultadoImovel.valorMeta, prazo: meses, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: reserva };
    this.http.post<Sonho>(this.api, body).subscribe({
      next: s => { this.sonhos = this.sonhos.map(x => x.id === tid ? s : x); this.cdr.detectChanges(); },
      error: () => { this.sonhos = this.sonhos.filter(x => x.id !== tid); this.cdr.detectChanges(); }
    });
  }

  adicionarCarroAosSonhos() {
    const { valorNecessario } = this.resultadoCarro;
    const meses = this.simCarro.meses ?? 12;
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    const tid = this.tempId--;
    const marca = this.fipeMarcas.find(m => m.codigo === this.fipeMarcaCod)?.nome ?? '';
    const modelo = this.fipeModelos.find(m => String(m.codigo) === String(this.fipeModeloCod))?.nome ?? '';
    const nomeCarro = `${marca} ${modelo}`.trim() || 'Carro';
    const temp: Sonho = { id: tid, nome: nomeCarro, descricao: '', valor_total: valorNecessario, prazo: meses, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.sonhos = [...this.sonhos, temp];
    this.simuladorAberto = false;
    this.cdr.detectChanges();
    const body = { nome: nomeCarro, descricao: '', valor_total: valorNecessario, prazo: meses, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.http.post<Sonho>(this.api, body).subscribe({
      next: s => { this.sonhos = this.sonhos.map(x => x.id === tid ? s : x); this.cdr.detectChanges(); },
      error: () => { this.sonhos = this.sonhos.filter(x => x.id !== tid); this.cdr.detectChanges(); }
    });
  }

  get resultadoCarro(): { valorNecessario: number; mim: number } {
    const valorNovo = this.simCarro.valorNovo ?? 0;
    const valorAtual = this.simCarro.temCarroAtual
      ? (this.simCarro.valorAtualEditado ?? this.valorCarroAtualDaqui ?? this.simCarro.valorAtual ?? 0)
      : 0;
    const meses = this.simCarro.meses ?? 1;
    const valorNecessario = Math.max(0, valorNovo - valorAtual);
    const mim = meses > 0 ? Math.round(valorNecessario / meses) : 0;
    return { valorNecessario, mim };
  }

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  // O app roda sem Zone.js: respostas assíncronas só aparecem na tela depois de pedir a atualização.
  private naTela<T>(fn: () => T): T {
    const r = fn();
    this.cdr.detectChanges();
    return r;
  }

  ngOnInit() { this.carregar(); }

  carregar() {
    this.carregando = true;
    this.http.get<Sonho[]>(this.api).subscribe({
      next: (s) => { this.sonhos = s; this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  adicionarLinha() {
    if (this.adicionando) return;
    const hoje = new Date();
    const dataInicio = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
    const tid = this.tempId--;
    const temp: Sonho = { id: tid, nome: '', descricao: '', valor_total: null, prazo: 0, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.sonhos = [...this.sonhos, temp];
    this.cdr.detectChanges();
    this.adicionando = true;
    const body = { nome: '', descricao: '', valor_total: null, prazo: 0, rentabilidade: 1.0, valor_inicial: null, data_inicio: dataInicio, valor_selado: null };
    this.http.post<Sonho>(this.api, body).subscribe({
      next: (s) => {
        this.sonhos = this.sonhos.map(x => x.id === tid ? s : x);
        this.adicionando = false; this.cdr.detectChanges();
      },
      error: () => { this.adicionando = false; this.cdr.detectChanges(); },
    });
  }

  salvar(s: Sonho) {
    if (!s.id || s.id < 0) return;
    const body = { nome: s.nome, descricao: s.descricao ?? '', valor_total: s.valor_total || null, prazo: s.prazo || 0, rentabilidade: s.rentabilidade, valor_inicial: s.valor_inicial || null, data_inicio: s.data_inicio, valor_selado: s.valor_selado || null };
    this.http.put<Sonho>(`${this.api}/${s.id}`, body).subscribe({ next: (updated) => { this.sonhos = this.sonhos.map(x => x.id === updated.id ? updated : x); this.cdr.detectChanges(); } });
  }

  excluir(s: Sonho) {
    if (s.id < 0) { this.sonhos = this.sonhos.filter(x => x.id !== s.id); this.cdr.detectChanges(); return; }
    this.http.delete(`${this.api}/${s.id}`).subscribe({ next: () => { this.sonhos = this.sonhos.filter(x => x.id !== s.id); this.cdr.detectChanges(); } });
  }

  // ── Cálculos ────────────────────────────────────────────────

  dataFim(s: Sonho): string {
    const d = this.parseData(s.data_inicio);
    if (!d || !s.prazo) return '-';
    d.setMonth(d.getMonth() + (s.prazo || 0));
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  mesesRestantes(s: Sonho): number | null { return mesesRestantesSonho(s); }

  mim(s: Sonho): number | null { return mimSonho(s); }

  private parseData(str: string): Date | null { return parseDataSonho(str); }

  // ── Formatação ───────────────────────────────────────────────

  fmt(v: number | null): string {
    if (v === null || v === undefined) return '-';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  fmtDisplay(v: number | null): string {
    if (v === null || v === undefined || v === 0) return '';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  onFocusValor(event: Event, v: number | null) {
    const el = event.target as HTMLInputElement;
    el.value = v != null && v !== 0 ? String(v).replace('.', ',') : '';
  }

  onBlurValorTotal(event: Event, s: Sonho) {
    const el = event.target as HTMLInputElement;
    const raw = parseFloat(el.value.replace(/\./g, '').replace(',', '.'));
    s.valor_total = isNaN(raw) ? null : raw;
    el.value = this.fmtDisplay(s.valor_total);
    this.salvar(s);
  }

  onBlurValorInicial(event: Event, s: Sonho) {
    const el = event.target as HTMLInputElement;
    const raw = parseFloat(el.value.replace(/\./g, '').replace(',', '.'));
    s.valor_inicial = isNaN(raw) ? null : raw;
    el.value = this.fmtDisplay(s.valor_inicial);
    this.salvar(s);
  }

  formatarData(event: Event, s: Sonho) {
    const el = event.target as HTMLInputElement;
    let v = el.value.replace(/\D/g, '').slice(0, 8);
    if (v.length > 4) v = v.slice(0,2) + '/' + v.slice(2,4) + '/' + v.slice(4);
    else if (v.length > 2) v = v.slice(0,2) + '/' + v.slice(2);
    el.value = v;
    s.data_inicio = v;
  }

  onBlurSimNum(event: Event, obj: any, campo: string) {
    const el = event.target as HTMLInputElement;
    const raw = parseFloat(el.value.replace(/\./g, '').replace(',', '.'));
    obj[campo] = isNaN(raw) ? null : raw;
    el.value = this.fmtDisplay(obj[campo]);
  }

  // Rentabilidade da grade sempre com duas casas ("1,00"). Se o texto não mudou, mantém o valor
  // guardado (a aposentadoria grava a taxa real com 4 casas para o M.I.M. bater com o simulador).
  onBlurRentabilidade(event: Event, s: Sonho) {
    const el = event.target as HTMLInputElement;
    if (el.value === this.fmtPct(s.rentabilidade)) return;
    const n = this.lerPct(el.value);
    s.rentabilidade = n === null || n < 0 ? 0 : n;
    el.value = this.fmtPct(s.rentabilidade);
    this.salvar(s);
  }

  onBlurValorSelado(event: Event, s: Sonho) {
    const el = event.target as HTMLInputElement;
    const raw = parseFloat(el.value.replace(/\./g, '').replace(',', '.'));
    s.valor_selado = isNaN(raw) ? null : raw;
    el.value = this.fmtDisplay(s.valor_selado);
    this.salvar(s);
  }

  get totalMim(): number {
    return this.sonhos.reduce((acc, s) => acc + (this.mim(s) ?? 0), 0);
  }

  // ── Resumo ───────────────────────────────────────────────────

  get resumoLinhas(): { nome: string; mim: number; totalAlocado: number | null; mesesRestantes: number | null }[] {
    return this.sonhos.map(s => ({
      nome: s.nome || '—',
      mim: this.mim(s) ?? 0,
      totalAlocado: (s.valor_selado && s.valor_selado > 0) ? s.valor_selado : (s.valor_inicial || null),
      mesesRestantes: this.mesesRestantes(s),
    }));
  }

  barPct(mim: number): number {
    const total = this.totalMim;
    return total > 0 ? Math.round((mim / total) * 100) : 0;
  }

  pctMim(mim: number): string {
    return this.barPct(mim) + '%';
  }
}
