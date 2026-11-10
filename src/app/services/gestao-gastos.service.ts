import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Gasto } from './gasto.service';
import { SonhoCalculo } from '../shared/calculo-sonhos';

export interface RealizadoMes {
  gasto_id: number;
  chave: string; // AAAA-MM
  mes: number;
  total: number;
  quantidade: number;
}

// Quanto saiu num mês (AAAA-MM) de um item eventual, em qualquer ano: base do limite anual móvel.
export interface MensalEventual {
  gasto_id: number;
  mes: string;
  total: number;
}

export interface GestaoGastos {
  ano: number;
  itens: Gasto[];
  realizados: RealizadoMes[];
  mensal_eventuais: MensalEventual[];
  // Gestão de Pagamentos
  receitas_realizadas: { chave: string; total: number; quantidade: number }[];
  receita_planejada: number;
  dividas: DividaPagamento[];
  ajustes: AjustePagamento[];
  outras_dividas_meta: number;
  sonhos: SonhoCalculo[];
}

export interface DividaPagamento {
  id: number;
  guia: string;
  nome: string;
  pmt: number;
  parcelas_totais: number | null;
  parcelas_restantes: number | null;
}

export type TipoAjuste = 'divida' | 'outras_dividas' | 'investimento';

export interface AjustePagamento {
  tipo: TipoAjuste;
  ref_id: number;
  chave: string; // AAAA-MM
  valor: number;
}

export interface LancamentoReceita {
  id?: number;
  data: string;
  valor: number;
  descricao: string;
}

export type OrigemLancamento = 'manual' | 'whatsapp' | 'fatura';

export interface LancamentoGasto {
  id?: number;
  gasto_id: number;
  data: string;
  valor: number;
  descricao: string;
  origem?: OrigemLancamento;
  recorrencia_grupo?: string | null;
  parcela?: number | null;
  total_parcelas?: number | null;
  meses?: number; // só no envio: > 1 cria a recorrência mensal
  dividir?: boolean; // só no envio: parcelado — `valor` é o total, dividido em `meses` parcelas
  criado_em?: string;
}

// Parcela de uma compra parcelada, com o item e a categoria (Visão dos Parcelados)
export interface ParcelaGasto extends LancamentoGasto {
  item: string | null;
  categoria: string | null;
}

export interface GastoSuspenso {
  id: number;
  texto_original: string;
  valor: number | null;
  data: string | null;
  descricao: string;
  gasto_sugerido_id: number | null;
  origem: OrigemLancamento;
  parcela: number | null; // fatura: parcela x de y; confirmar lança da x até a y
  total_parcelas: number | null;
  aviso: string; // ex.: possível lançamento repetido
  criado_em: string;
}

export interface LancamentoEditado extends LancamentoGasto {
  // Parcelas seguintes que também mudaram de item (com o item de antes, para atualizar a grade).
  seguintes_movidos: (LancamentoGasto & { gasto_anterior: number })[];
}

export interface ResultadoLote {
  lancados: number[]; // ids dos suspensos lançados
  criados: LancamentoGasto[];
  falhas: { id: number; erro: string }[];
}

export interface ResumoImportacao {
  lidos: number;
  lancados: number;
  parcelas_lancadas: number;
  suspensos: number;
  duplicados: number;
  ja_em_suspenso: number;
  ignorados: number;
}

export type ResultadoEntrada =
  | { resultado: 'lancado'; lancamento: LancamentoGasto }
  | { resultado: 'suspenso'; suspenso: GastoSuspenso };

// Sugestão de meta de um item: mensais pela média dos últimos 3 meses fechados (sem os zerados);
// eventuais pela projeção do consumo observado para 12 meses
export interface SugestaoMeta {
  id: number;
  descricao: string;
  categoria: string;
  classe: string;
  atual: number;
  sugerido: number;
  base:
    | { tipo: 'media'; meses: { mes: string; total: number }[]; considerados: number }
    | { tipo: 'projecao'; de: string; ate: string; meses_observados: number; soma: number };
}
export interface SugestaoMetas { referencia: string; sugestoes: SugestaoMeta[]; }

@Injectable({ providedIn: 'root' })
export class GestaoGastosService {
  private api = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // Faixa de meses (AAAA-MM), que pode atravessar a virada do ano.
  listarReceitas(mes: string): Observable<LancamentoReceita[]> {
    return this.http.get<LancamentoReceita[]>(`${this.api}/lancamentos-receitas`, { params: { mes } });
  }

  criarReceita(l: LancamentoReceita): Observable<LancamentoReceita> {
    return this.http.post<LancamentoReceita>(`${this.api}/lancamentos-receitas`, l);
  }

  excluirReceita(id: number): Observable<unknown> {
    return this.http.delete(`${this.api}/lancamentos-receitas/${id}`);
  }

  // valor null volta ao previsto
  salvarAjuste(tipo: TipoAjuste, refId: number, chave: string, valor: number | null): Observable<unknown> {
    return this.http.put(`${this.api}/gestao-ajustes`, { tipo, ref_id: refId, chave, valor });
  }

  salvarMetaOutrasDividas(valor: number): Observable<{ valor: number }> {
    return this.http.put<{ valor: number }>(`${this.api}/gestao-config/outras-dividas-meta`, { valor });
  }

  // Metas sugeridas pelo histórico (não grava nada; a tela aplica item a item)
  sugestaoMetas(): Observable<SugestaoMetas> {
    return this.http.get<SugestaoMetas>(`${this.api}/gestao-gastos/sugestao-metas`);
  }

  obter(de: string, ate: string): Observable<GestaoGastos> {
    return this.http.get<GestaoGastos>(`${this.api}/gestao-gastos`, { params: { de, ate } });
  }

  listarParcelados(): Observable<ParcelaGasto[]> {
    return this.http.get<ParcelaGasto[]>(`${this.api}/lancamentos-gastos/parcelados`);
  }

  listarLancamentos(gastoId: number, mes: string): Observable<LancamentoGasto[]> {
    return this.http.get<LancamentoGasto[]>(`${this.api}/lancamentos-gastos`, { params: { gasto_id: gastoId, mes } });
  }

  lancar(l: LancamentoGasto): Observable<LancamentoGasto> {
    return this.http.post<LancamentoGasto>(`${this.api}/lancamentos-gastos`, l);
  }

  lancarRecorrente(l: LancamentoGasto): Observable<LancamentoGasto[]> {
    return this.http.post<LancamentoGasto[]>(`${this.api}/lancamentos-gastos`, l);
  }

  // ── Gastos em suspenso ──
  enviarMensagem(texto: string, origem: 'manual' | 'whatsapp' = 'whatsapp'): Observable<ResultadoEntrada> {
    return this.http.post<ResultadoEntrada>(`${this.api}/gastos-suspensos/entrada`, { texto, origem });
  }

  listarSuspensos(): Observable<GastoSuspenso[]> {
    return this.http.get<GastoSuspenso[]>(`${this.api}/gastos-suspensos`);
  }

  salvarSuspenso(s: GastoSuspenso): Observable<GastoSuspenso> {
    return this.http.put<GastoSuspenso>(`${this.api}/gastos-suspensos/${s.id}`, s);
  }

  // Devolve todos os lançamentos criados (mais de um quando é parcela de fatura).
  confirmarSuspenso(s: GastoSuspenso): Observable<LancamentoGasto[]> {
    return this.http.post<LancamentoGasto[]>(`${this.api}/gastos-suspensos/${s.id}/confirmar`, {
      gasto_id: s.gasto_sugerido_id, valor: s.valor, data: s.data, descricao: s.descricao,
    });
  }

  // `senha`: só para PDF protegido; o servidor responde codigo SENHA_NECESSARIA / SENHA_INCORRETA.
  importarFatura(nomeArquivo: string, conteudoBase64: string, senha?: string): Observable<ResumoImportacao> {
    return this.http.post<ResumoImportacao>(`${this.api}/faturas/importar`, { nome_arquivo: nomeArquivo, conteudo_base64: conteudoBase64, senha });
  }

  // Lança vários suspensos no mesmo item de uma vez; cada um com o próprio valor, data e descrição.
  confirmarLote(gastoId: number, itens: GastoSuspenso[]): Observable<ResultadoLote> {
    return this.http.post<ResultadoLote>(`${this.api}/gastos-suspensos/confirmar-lote`, {
      gasto_id: gastoId, itens: itens.map((s) => ({ id: s.id, valor: s.valor, data: s.data, descricao: s.descricao })),
    });
  }

  excluirSuspenso(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.api}/gastos-suspensos/${id}`);
  }

  // `gasto_id` troca o item; `item_seguintes` leva a troca às próximas parcelas da mesma recorrência.
  editarLancamento(
    id: number, l: Pick<LancamentoGasto, 'data' | 'valor' | 'descricao' | 'gasto_id'> & { item_seguintes?: boolean },
  ): Observable<LancamentoEditado> {
    return this.http.put<LancamentoEditado>(`${this.api}/lancamentos-gastos/${id}`, l);
  }

  excluirLancamento(id: number, seguintes = false): Observable<{ ok: boolean; removidos: LancamentoGasto[] }> {
    return this.http.delete<{ ok: boolean; removidos: LancamentoGasto[] }>(`${this.api}/lancamentos-gastos/${id}`, {
      params: seguintes ? { seguintes: '1' } : {},
    });
  }
}
