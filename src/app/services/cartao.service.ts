import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Cartao {
  id?: number;
  usuario_id?: number;
  nome: string;
  ultimos_digitos?: string;
  banco?: string;
  dia_fechamento?: number | null; // 1 a 31
  dia_vencimento?: number | null; // 1 a 31
  criado_em?: string;
}

export interface Banco {
  id: string;
  nome: string;
  sigla: string;
  cor: string;
  corTexto?: string;
}

// Não usamos as logos oficiais dos bancos (direitos de marca) — cada banco é representado
// por um selo com a cor de marca aproximada e uma sigla, no mesmo estilo dos demais ícones do app.
export const BANCOS: Banco[] = [
  { id: 'itau', nome: 'Itaú', sigla: 'It', cor: '#EC7000' },
  { id: 'bb', nome: 'Banco do Brasil', sigla: 'BB', cor: '#FADB00', corTexto: '#003087' },
  { id: 'caixa', nome: 'Caixa', sigla: 'CX', cor: '#0070AD' },
  { id: 'santander', nome: 'Santander', sigla: 'St', cor: '#EC0000' },
  { id: 'bradesco', nome: 'Bradesco', sigla: 'Bd', cor: '#CC092F' },
  { id: 'nubank', nome: 'Nubank', sigla: 'Nu', cor: '#8A05BE' },
  { id: 'inter', nome: 'Inter', sigla: 'In', cor: '#FF7A00' },
  { id: 'porto', nome: 'Porto Seguro', sigla: 'Po', cor: '#003DA5' },
  { id: 'sicoob', nome: 'Sicoob', sigla: 'Sc', cor: '#00995D' },
  { id: 'outros', nome: 'Outros', sigla: '?', cor: '#8a9d92' },
];

@Injectable({ providedIn: 'root' })
export class CartaoService {
  private api = `${environment.apiUrl}/cartoes`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Cartao[]> { return this.http.get<Cartao[]>(this.api); }
  criar(c: Cartao): Observable<Cartao> { return this.http.post<Cartao>(this.api, c); }
  atualizar(id: number, c: Cartao): Observable<Cartao> { return this.http.put<Cartao>(`${this.api}/${id}`, c); }
  excluir(id: number): Observable<{ ok: boolean }> { return this.http.delete<{ ok: boolean }>(`${this.api}/${id}`); }
}
