import { AuthPayload } from './auth.service';
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ClientePlanejador, Convite } from './admin.service';

// Área do planejador financeiro: clientes vinculados e convites (ver backend/planejadores.js)
@Injectable({ providedIn: 'root' })
export class PlanejadorService {
  private http = inject(HttpClient);
  private api = `${environment.apiUrl}/planejador`;

  clientes(): Observable<ClientePlanejador[]> { return this.http.get<ClientePlanejador[]>(`${this.api}/clientes`); }
  convites(): Observable<Convite[]> { return this.http.get<Convite[]>(`${this.api}/convites`); }
  convidar(email: string, nome: string): Observable<Convite> { return this.http.post<Convite>(`${this.api}/convites`, { email, nome }); }
  reenviarConvite(id: number): Observable<Convite> { return this.http.post<Convite>(`${this.api}/convites/${id}/reenviar`, {}); }
  cancelarConvite(id: number): Observable<Convite> { return this.http.post<Convite>(`${this.api}/convites/${id}/cancelar`, {}); }
  removerAcesso(id: number): Observable<unknown> { return this.http.post(`${this.api}/clientes/${id}/remover-acesso`, {}); }
  devolverAcesso(id: number): Observable<unknown> { return this.http.post(`${this.api}/clientes/${id}/devolver-acesso`, {}); }
  acessarCliente(id: number): Observable<AuthPayload> { return this.http.post<AuthPayload>(`${this.api}/clientes/${id}/acessar`, {}); }
}
