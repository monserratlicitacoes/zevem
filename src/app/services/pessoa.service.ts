import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Pessoa {
  id?: number;
  usuario_id?: number;
  nome: string;
  data_nascimento: string;
  cpf: string;
  email: string;
  telefone: string;
  risco_renda: string;
  facilidade_renda: string;
  telefone_verificado?: boolean; // a pessoa confirmou o WhatsApp mandando o código
  criado_em?: string;
}

export interface CodigoWhatsapp { codigo?: string; mensagem?: string; numero_zevem?: string | null; link?: string | null; ja_confirmado?: boolean; }

export const OPCOES_RISCO = ['Muito Baixo', 'Baixo', 'Mediano', 'Alto', 'Muito Alto'];
export const OPCOES_FACILIDADE = ['Muito Fácil', 'Fácil', 'Razoável', 'Difícil', 'Muito Difícil'];

@Injectable({ providedIn: 'root' })
export class PessoaService {
  private api = `${environment.apiUrl}/pessoas`;

  constructor(private http: HttpClient) {}

  listar(): Observable<Pessoa[]> { return this.http.get<Pessoa[]>(this.api); }
  criar(p: Pessoa): Observable<Pessoa> { return this.http.post<Pessoa>(this.api, p); }
  atualizar(id: number, p: Pessoa): Observable<Pessoa> { return this.http.put<Pessoa>(`${this.api}/${id}`, p); }
  codigoWhatsapp(id: number): Observable<CodigoWhatsapp> { return this.http.post<CodigoWhatsapp>(`${this.api}/${id}/telefone/codigo`, {}); }
  excluir(id: number): Observable<{ ok: boolean }> { return this.http.delete<{ ok: boolean }>(`${this.api}/${id}`); }
}
