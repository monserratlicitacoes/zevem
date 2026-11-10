import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Alertas pelo WhatsApp (ver backend/whatsapp.js): configuração por tipo, simulador e histórico.
export type TipoAlerta =
  | 'conta_vencendo' | 'fatura_fecha' | 'melhor_dia_compra' | 'fatura_vence'
  | 'saldo_pos_lancamento' | 'meta_atingida' | 'limite_programado';

export interface ParametrosAlerta {
  dias_antes?: number[] | number;
  percentuais?: number[];
  dias_semana?: number[];
  hora?: number;
  itens?: number[];
  avisar_outras_pessoas?: boolean;
}

export interface ConfigAlerta {
  tipo: TipoAlerta;
  titulo: string;
  descricao: string;
  template: string;
  ativo: boolean;
  parametros: ParametrosAlerta;
  destinatarios: 'todos' | number[];
}

export interface PessoaWhatsapp { id: number; nome: string; telefone: string; tem_telefone: boolean; telefone_pendente?: boolean; }
export interface ItemAlerta { id: number; descricao: string; categoria: string; categoria_nome: string; meta: number; }

export interface ConfigAlertas {
  integracao_ativa: boolean;
  ia_ativa: boolean;
  pessoas: PessoaWhatsapp[];
  tipos: ConfigAlerta[];
  itens: ItemAlerta[];
}

export interface RespostaSimulador {
  id: number;
  acao: string;
  intencao: string | null;
  resposta: string;
  via?: string;
}

export interface Aviso {
  id: number;
  tipo: string;
  titulo: string;
  mensagem: string;
  status: string; // pendente | reservado | enviado | falhou | sem_canal | sem_destino | expirado
  pessoa: string | null;
  data_ref: string;
  criado_em: string;
  enviado_em: string | null;
}

// Texto de um tipo de alerta (master): vazio = padrão
export interface TextoAlerta {
  tipo: TipoAlerta;
  titulo: string;
  padrao: string;
  texto: string;
  variaveis: string[];
  exemplo: string;
  valores_exemplo: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class AlertasService {
  private api = environment.apiUrl;

  constructor(private http: HttpClient) {}

  config(): Observable<ConfigAlertas> {
    return this.http.get<ConfigAlertas>(`${this.api}/alertas/config`);
  }

  salvar(c: ConfigAlerta): Observable<ConfigAlerta> {
    return this.http.put<ConfigAlerta>(`${this.api}/alertas/config/${c.tipo}`, {
      ativo: c.ativo, parametros: c.parametros, destinatarios: c.destinatarios,
    });
  }

  simular(texto: string, pessoaId: number | null): Observable<RespostaSimulador> {
    return this.http.post<RespostaSimulador>(`${this.api}/whatsapp/simular`, { texto, pessoa_id: pessoaId });
  }

  textos(): Observable<TextoAlerta[]> { return this.http.get<TextoAlerta[]>(`${this.api}/admin/textos-alertas`); }
  salvarTexto(tipo: TipoAlerta, texto: string): Observable<{ texto: string; exemplo: string }> {
    return this.http.put<{ texto: string; exemplo: string }>(`${this.api}/admin/textos-alertas/${tipo}`, { texto });
  }

  avisos(limite = 30): Observable<Aviso[]> {
    return this.http.get<Aviso[]>(`${this.api}/avisos`, { params: { limite } });
  }
}
