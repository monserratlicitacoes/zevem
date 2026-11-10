import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';
import { VIDEOS_ETAPAS } from '../shared/video-panel/videos-etapas';

// Vídeos de instrução que a pessoa já assistiu (deu play no painel da direita).
// Cada vídeo é identificado pela página (primeiro trecho da rota) e pelo título em videos-etapas.ts.
// Fica no servidor (o master acompanha no painel de clientes), com cópia no navegador para a tela
// responder na hora. Também alimenta o "Seu progresso" da barra lateral.
@Injectable({ providedIn: 'root' })
export class VideosAssistidosService {
  private auth = inject(AuthService);
  private http = inject(HttpClient);
  private api = `${environment.apiUrl}/videos-assistidos`;
  private assistidos = signal<Set<string>>(this.carregar());

  constructor() {
    if (this.auth.isLoggedIn) this.sincronizar();
  }

  // Junta o que está no servidor com o que este navegador já tinha (de antes de existir o registro
  // no servidor) e envia ao servidor o que faltar lá
  private sincronizar() {
    this.http.get<string[]>(this.api).subscribe({
      next: (doServidor) => {
        const servidor = new Set(doServidor);
        const faltam = [...this.assistidos()].filter((k) => !servidor.has(k));
        this.salvarLocal(new Set([...servidor, ...this.assistidos()]));
        if (faltam.length) this.http.post(this.api, { chaves: faltam }).subscribe({ error: () => {} });
      },
      error: () => { /* sem servidor: segue com a cópia local */ },
    });
  }

  // Todos os vídeos das páginas ativas no menu (uma página desativada, sem rota, fica fora da conta)
  readonly todos: string[] = (() => {
    const rotas = new Set(inject(Router).config.map((r) => r.path));
    return Object.entries(VIDEOS_ETAPAS)
      .filter(([rota]) => rotas.has(rota))
      .flatMap(([rota, p]) => [p, ...(p.outros ?? [])]
        .flatMap((g) => [g.principal, ...(g.subvideos ?? [])])
        .map((v) => this.chave(rota, v.titulo)));
  })();

  readonly totalVideos = this.todos.length;
  readonly totalAssistidos = computed(() => this.todos.filter((k) => this.assistidos().has(k)).length);
  // "Seu progresso" da barra lateral: % dos vídeos de instrução já assistidos
  readonly progresso = computed(() => (this.totalVideos ? Math.round((this.totalAssistidos() / this.totalVideos) * 100) : 0));

  private get storageKey(): string { return `apple-green-videos-assistidos:${this.auth.email ?? ''}`; }
  private chave(rota: string, titulo: string): string { return `${rota}::${titulo}`; }

  assistido(rota: string, titulo: string): boolean {
    return this.assistidos().has(this.chave(rota, titulo));
  }

  marcar(rota: string, titulo: string) {
    const k = this.chave(rota, titulo);
    if (this.assistidos().has(k)) return;
    const novo = new Set(this.assistidos());
    novo.add(k);
    this.salvarLocal(novo);
    this.http.post(this.api, { chave: k }).subscribe({ error: () => {} });
  }

  private salvarLocal(s: Set<string>) {
    this.assistidos.set(s);
    try { localStorage.setItem(this.storageKey, JSON.stringify([...s])); } catch {}
  }

  private carregar(): Set<string> {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  }
}
