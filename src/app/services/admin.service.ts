import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Área master (ver backend/admin.js e backend/pagamentos.js)
export interface UltimoGasto { data: string; valor: number; descricao: string; item: string | null; origem: string; criado_em: string; }
export interface PartesUtilizacao { acesso: number; lancamentos: number; cadastro: number; whatsapp: number; }

export interface ClienteAdmin {
  id: number;
  nome: string;
  email: string;
  telefone: string;
  pessoas: { nome: string; telefone: string; email: string }[];
  casado: boolean;
  criado_em: string;
  ultimo_acesso: string | null;
  renda_mensal: number;
  patrimonio_financeiro: number;
  nivel_saude: number | null;
  nivel_saude_motivo: string;
  grau_comprometimento: number | null;
  componentes: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I', number>;
  videos_assistidos: string[];
  ultimo_gasto: UltimoGasto | null;
  utilizacao_partes: PartesUtilizacao;
  master: boolean;
}

export interface Plano { id?: number; nome: string; valor_anual: number; parcelas: number; ativo: boolean | number; assinantes?: number; }

export interface AssinaturaResumo {
  id: number;
  status: 'ativa' | 'inadimplente' | 'cancelada' | 'encerrada';
  plano: string;
  ciclo: number;
  inicio_ciclo: string;
  fim_ciclo: string;
  valor_ciclo: number;
  valor_mensal: number;
  renovacao_automatica: boolean;
  provedor: string;
  parcelas_pagas: number;
  total_parcelas: number;
  valor_pago_ciclo: number;
  em_atraso: number;
  parcelas_em_atraso: number;
  proximo_vencimento: string | null;
  proxima_parcela: number | null;
}
export interface ClienteFinanceiro { usuario_id: number; nome: string; email: string; assinatura: AssinaturaResumo | null; pedido_cancelamento: boolean; }
export interface Indicadores {
  mrr: number; arpu: number; assinantes: number;
  churn_mes: number | null; churn_3m: number | null; ltv: number | null;
  receita_media_por_assinante: number; renovacoes_desligadas: number; pedidos_cancelamento_abertos: number;
}
export interface MesHistorico { mes: string; assinantes_inicio: number; novas: number; encerradas: number; churn: number | null; mrr: number; }
export interface PedidoCancelamento {
  id: number; usuario_id: number; nome: string; email: string; motivo: string; detalhe: string;
  canal: 'app' | 'whatsapp' | 'atendimento'; status: 'aberto' | 'concluido' | 'revertido';
  resolucao: string | null; observacao: string | null; criado_em: string; resolvido_em: string | null; fim_ciclo: string;
}
export interface Financeiro {
  provedor: string;
  indicadores: Indicadores;
  historico: MesHistorico[];
  resumo: {
    clientes: number; assinantes_ativos: number; inadimplentes: number; receita_mensal_recorrente: number;
    recebido_no_mes: number; a_receber_no_mes: number; em_atraso: number;
  };
  clientes: ClienteFinanceiro[];
}
export interface Cobranca {
  id: number; ciclo: number; parcela: number; total_parcelas: number; valor: number; vencimento: string;
  status: 'pendente' | 'paga' | 'vencida' | 'cancelada' | 'estornada'; pago_em: string | null; forma_pagamento: string | null; link_pagamento: string | null;
}

export interface Convite {
  id: number; email: string; nome: string; criado_em: string; expira_em: string;
  enviado_em: string | null; erro_envio: string | null; usado_em: string | null; usuario_id: number | null;
  situacao: 'pendente' | 'aceito' | 'expirado' | 'cancelado'; link: string | null; aviso_email?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private http = inject(HttpClient);
  private api = `${environment.apiUrl}/admin`;

  clientes(): Observable<ClienteAdmin[]> { return this.http.get<ClienteAdmin[]>(`${this.api}/clientes`); }

  financeiro(): Observable<Financeiro> { return this.http.get<Financeiro>(`${this.api}/financeiro`); }
  planos(): Observable<Plano[]> { return this.http.get<Plano[]>(`${this.api}/planos`); }
  salvarPlano(p: Plano): Observable<Plano> {
    return p.id ? this.http.put<Plano>(`${this.api}/planos/${p.id}`, p) : this.http.post<Plano>(`${this.api}/planos`, p);
  }
  criarAssinatura(usuarioId: number, planoId: number, inicio: string): Observable<{ id: number }> {
    return this.http.post<{ id: number }>(`${this.api}/assinaturas`, { usuario_id: usuarioId, plano_id: planoId, inicio });
  }
  renovacao(id: number, ligada: boolean): Observable<unknown> { return this.http.put(`${this.api}/assinaturas/${id}`, { renovacao_automatica: ligada }); }
  cancelar(id: number, imediato: boolean): Observable<unknown> { return this.http.post(`${this.api}/assinaturas/${id}/cancelar`, { imediato }); }
  cobrancas(assinaturaId: number): Observable<Cobranca[]> { return this.http.get<Cobranca[]>(`${this.api}/assinaturas/${assinaturaId}/cobrancas`); }
  baixa(cobrancaId: number, forma: string, pagoEm: string): Observable<unknown> {
    return this.http.post(`${this.api}/cobrancas/${cobrancaId}/baixa`, { forma, pago_em: pagoEm });
  }
  cancelamentos(): Observable<PedidoCancelamento[]> { return this.http.get<PedidoCancelamento[]>(`${this.api}/cancelamentos`); }
  motivos(): Observable<Record<string, string>> { return this.http.get<Record<string, string>>(`${environment.apiUrl}/cancelamento/motivos`); }
  registrarCancelamento(usuarioId: number, motivo: string, canal: string, detalhe: string): Observable<unknown> {
    return this.http.post(`${this.api}/cancelamentos`, { usuario_id: usuarioId, motivo, canal, detalhe });
  }
  resolverCancelamento(id: number, acao: 'cancelar_renovacao' | 'cancelar_agora' | 'revertido', observacao: string): Observable<unknown> {
    return this.http.post(`${this.api}/cancelamentos/${id}/resolver`, { acao, observacao });
  }
  convites(): Observable<Convite[]> { return this.http.get<Convite[]>(`${this.api}/convites`); }
  convidar(email: string, nome: string): Observable<Convite> { return this.http.post<Convite>(`${this.api}/convites`, { email, nome }); }
  reenviarConvite(id: number): Observable<Convite> { return this.http.post<Convite>(`${this.api}/convites/${id}/reenviar`, {}); }
  cancelarConvite(id: number): Observable<Convite> { return this.http.post<Convite>(`${this.api}/convites/${id}/cancelar`, {}); }
  desfazerBaixa(cobrancaId: number): Observable<unknown> { return this.http.post(`${this.api}/cobrancas/${cobrancaId}/desfazer-baixa`, {}); }
}
