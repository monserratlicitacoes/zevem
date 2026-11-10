import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Recebimento {
  id?: number;
  usuario_id?: number;
  descricao: string;
  origem: string;
  classe: string;
  valor: number;
  valor_mensal?: number;
  criado_em?: string;
}

export const CLASSES_RECEBIMENTO = [
  'Mensal Flexível',
  'Mensal Comprometido',
  'Eventual Flexível',
  'Eventual Comprometido',
];

@Injectable({ providedIn: 'root' })
export class RecebimentoService {
  private api = `${environment.apiUrl}/recebimentos`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Recebimento[]> { return this.http.get<Recebimento[]>(this.api); }
  criar(r: Partial<Recebimento>): Observable<Recebimento> { return this.http.post<Recebimento>(this.api, r); }
  atualizar(id: number, r: Partial<Recebimento>): Observable<Recebimento> { return this.http.put<Recebimento>(`${this.api}/${id}`, r); }
  excluir(id: number): Observable<{ ok: boolean }> { return this.http.delete<{ ok: boolean }>(`${this.api}/${id}`); }
}
