import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';

// Anúncio "Contrate um planejador" e avisos que surgem no acesso, configurados pelo master
// (menu Anúncios e avisos). Ver backend/admin.js.
export interface PontoAnuncio { titulo: string; texto: string; }
export interface ConfigAnuncio {
  ativo: boolean;
  botao_menu: string;
  selo: string;
  titulo: string;
  pontos: PontoAnuncio[];
  destaque: string;
  botao_agendar: string;
  whatsapp: string;
  mensagem: string; // {nome} = nome de quem agenda
  foto_url: string;
  cor_botao_menu: ChaveCor;
  cor_destaque: ChaveCor;
  cor_botao_agendar: ChaveCor;
}

// Paleta da marca para o anúncio. "hover" = cor que o botão assume com o mouse em cima.
export type ChaveCor = 'lima' | 'rosa' | 'floresta' | 'profundo' | 'lima_claro' | 'off_white';
export interface CorAnuncio { nome: string; fundo: string; texto: string; brilho: string; hover: ChaveCor; }
export const CORES_ANUNCIO: Record<ChaveCor, CorAnuncio> = {
  lima: { nome: 'Verde-limão', fundo: '#b8f15a', texto: '#05261a', brilho: '166, 244, 83', hover: 'rosa' },
  rosa: { nome: 'Rosa', fundo: '#ff2e63', texto: '#ffffff', brilho: '255, 46, 99', hover: 'lima' },
  floresta: { nome: 'Verde-floresta', fundo: '#0b3d2e', texto: '#f7f8f5', brilho: '21, 94, 59', hover: 'lima' },
  profundo: { nome: 'Verde-profundo', fundo: '#05261a', texto: '#b8f15a', brilho: '11, 46, 31', hover: 'lima' },
  lima_claro: { nome: 'Verde-claro', fundo: '#e6f8d2', texto: '#0b3d2e', brilho: '230, 248, 210', hover: 'lima' },
  off_white: { nome: 'Off-white', fundo: '#f7f8f5', texto: '#05261a', brilho: '245, 247, 242', hover: 'lima' },
};

// Variáveis CSS de uma cor (e da cor de hover), lidas pelos estilos do botão e da faixa
export function varsCor(chave: ChaveCor | undefined): Record<string, string> {
  const c = CORES_ANUNCIO[chave ?? 'lima'] ?? CORES_ANUNCIO.lima;
  const h = CORES_ANUNCIO[c.hover];
  return {
    '--cor-fundo': c.fundo, '--cor-texto': c.texto, '--cor-brilho': c.brilho,
    '--cor-hover-fundo': h.fundo, '--cor-hover-texto': h.texto, '--cor-hover-brilho': h.brilho,
  };
}

export interface Comunicado {
  id?: number;
  titulo: string;
  mensagem: string;
  imagem_url: string;
  botao_texto: string;
  botao_link: string;
  publico: 'todos' | 'assinantes' | 'nao_assinantes';
  inicio: string | null;
  fim: string | null;
  ativo: boolean | number;
  vistos?: number;
  criado_em?: string;
}

@Injectable({ providedIn: 'root' })
export class AnuncioService {
  private http = inject(HttpClient);
  private api = environment.apiUrl;

  // Anúncio em uso (null = ainda não carregado). O botão do menu lê daqui.
  readonly anuncio = signal<ConfigAnuncio | null>(null);

  // Imagens enviadas pelo master ficam no backend (/uploads/...)
  urlImagem(url: string): string { return url?.startsWith('/uploads/') ? `${this.api}${url}` : url; }

  carregar() {
    this.http.get<ConfigAnuncio>(`${this.api}/anuncio-planejador`).subscribe({ next: (a) => this.anuncio.set(a), error: () => {} });
  }

  // ── Cliente: avisos de acesso ──
  pendentes(): Observable<Comunicado[]> { return this.http.get<Comunicado[]>(`${this.api}/comunicados/pendentes`); }
  marcarVisto(id: number): Observable<unknown> { return this.http.post(`${this.api}/comunicados/${id}/visto`, {}); }

  // ── Master ──
  configAdmin(): Observable<ConfigAnuncio> { return this.http.get<ConfigAnuncio>(`${this.api}/admin/anuncio-planejador`); }
  salvarAnuncio(a: ConfigAnuncio): Observable<ConfigAnuncio> {
    return this.http.put<ConfigAnuncio>(`${this.api}/admin/anuncio-planejador`, a).pipe(tap((r) => this.anuncio.set(r)));
  }
  comunicados(): Observable<Comunicado[]> { return this.http.get<Comunicado[]>(`${this.api}/admin/comunicados`); }
  salvarComunicado(c: Comunicado): Observable<Comunicado> {
    return c.id ? this.http.put<Comunicado>(`${this.api}/admin/comunicados/${c.id}`, c) : this.http.post<Comunicado>(`${this.api}/admin/comunicados`, c);
  }
  excluirComunicado(id: number): Observable<unknown> { return this.http.delete(`${this.api}/admin/comunicados/${id}`); }
  enviarImagem(dataUrl: string): Observable<{ url: string }> { return this.http.post<{ url: string }>(`${this.api}/admin/uploads`, { arquivo: dataUrl }); }
}
