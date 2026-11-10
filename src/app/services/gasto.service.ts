import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Gasto {
  id?: number;
  usuario_id?: number;
  categoria: string;
  descricao: string;
  com_cartao: boolean;
  classe: string;
  valor: number;
  valor_mensal?: number;
  criado_em?: string;
  meta_desde?: string | null; // AAAA-MM-01: mês em que o item passou a ter meta
  dia_vencimento?: number | null; // dia do mês: só Mensal Comprometido fora do cartão
  mes_vencimento?: number | null; // mês do ano (1 a 12): só Eventual Comprometido fora do cartão
}

// Categoria fixa do sistema, presente em todo orçamento: um único item, sem edição nem exclusão,
// que só recebe lançamentos classificados manualmente.
export const CATEGORIA_NAO_IDENTIFICADO = 'nao-identificado';
export const NOME_NAO_IDENTIFICADO = 'Não Identificado';

export const CLASSES_GASTO = [
  'Mensal Flexível',
  'Mensal Comprometido',
  'Eventual Flexível',
  'Eventual Comprometido',
];

@Injectable({ providedIn: 'root' })
export class GastoService {
  private api = `${environment.apiUrl}/gastos`;

  constructor(private http: HttpClient) {}

  listar(categoria: string): Observable<Gasto[]> {
    return this.http.get<Gasto[]>(this.api, { params: { categoria } });
  }

  criar(g: Partial<Gasto>): Observable<Gasto> {
    return this.http.post<Gasto>(this.api, g);
  }

  atualizar(id: number, g: Partial<Gasto>): Observable<Gasto> {
    return this.http.put<Gasto>(`${this.api}/${id}`, g);
  }

  excluir(id: number): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.api}/${id}`);
  }
}
