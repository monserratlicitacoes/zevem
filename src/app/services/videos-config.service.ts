import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChamadaPainel, VideoEtapa } from '../shared/video-panel/videos-etapas';

// Ajustes do master no painel de vídeos (menu Master → Vídeos), por cima de videos-etapas.ts.
// Cada vídeo continua identificado pela página + título original (é por ele que o "assistido" é
// guardado); o master só troca o título exibido e o link. Ver backend/admin.js.
export interface AjusteVideo { titulo?: string; link?: string; }
export interface ConfigVideos {
  titulo_painel: string;
  videos: Record<string, AjusteVideo>;     // chave = "<rota>::<título original>"
  chamadas: Record<string, ChamadaPainel>; // chave = rota
}
export const TITULO_PAINEL_PADRAO = 'Acompanhe o passo a passo';
const VAZIA: ConfigVideos = { titulo_painel: '', videos: {}, chamadas: {} };

export const chaveVideo = (rota: string, tituloOriginal: string) => `${rota}::${tituloOriginal}`;

@Injectable({ providedIn: 'root' })
export class VideosConfigService {
  private http = inject(HttpClient);
  private api = environment.apiUrl;

  readonly config = signal<ConfigVideos>(VAZIA);

  carregar() { this.buscar().subscribe({ error: () => {} }); }
  buscar(): Observable<ConfigVideos> {
    return this.http.get<ConfigVideos>(`${this.api}/videos-painel`).pipe(tap((c) => this.config.set({ ...VAZIA, ...c })));
  }

  tituloPainel(): string { return this.config().titulo_painel || TITULO_PAINEL_PADRAO; }
  titulo(rota: string, v: VideoEtapa): string { return this.config().videos[chaveVideo(rota, v.titulo)]?.titulo || v.titulo; }
  link(rota: string, v: VideoEtapa): string {
    const a = this.config().videos[chaveVideo(rota, v.titulo)];
    return a && a.link !== undefined ? a.link : v.link;
  }
  chamada(rota: string, c: ChamadaPainel | undefined): ChamadaPainel | null {
    if (!c) return null;
    const a = this.config().chamadas[rota];
    return { texto: a?.texto || c.texto, link: a && a.link !== undefined ? a.link : c.link };
  }

  salvar(c: ConfigVideos): Observable<ConfigVideos> {
    return this.http.put<ConfigVideos>(`${this.api}/admin/videos-painel`, c).pipe(tap((r) => this.config.set({ ...VAZIA, ...r })));
  }
}
