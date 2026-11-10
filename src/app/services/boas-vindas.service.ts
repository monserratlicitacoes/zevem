import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Vídeo de boas-vindas (ver backend/admin.js): abre no primeiro acesso e só libera o app quando o vídeo
// termina e o cliente clica no botão. O master pode fechar a qualquer momento e testar quantas vezes quiser.
export interface ConfigBoasVindas { ativo: boolean; link: string; titulo: string; botao: string; total?: number; assistiram?: number; }
export interface SessaoBoasVindas { link: string; titulo: string; botao: string; podeFechar: boolean; teste: boolean; }

@Injectable({ providedIn: 'root' })
export class BoasVindasService {
  private http = inject(HttpClient);
  private api = environment.apiUrl;

  // Vídeo aberto agora (null = fechado)
  readonly aberto = signal<SessaoBoasVindas | null>(null);
  // false até saber se o vídeo vai abrir: os avisos de acesso esperam o vídeo terminar
  readonly resolvido = signal(false);

  carregar() {
    this.resolvido.set(false);
    this.http.get<{ mostrar: boolean; master: boolean; link: string; titulo: string; botao: string }>(`${this.api}/boas-vindas`).subscribe({
      next: (r) => {
        if (r.mostrar) this.aberto.set({ link: r.link, titulo: r.titulo, botao: r.botao, podeFechar: r.master, teste: false });
        this.resolvido.set(true);
      },
      error: () => this.resolvido.set(true),
    });
  }

  // Fecha o vídeo; fora do teste, registra que o cliente já passou pelas boas-vindas
  concluir() {
    const s = this.aberto();
    this.aberto.set(null);
    if (s && !s.teste) this.http.post(`${this.api}/boas-vindas/concluir`, {}).subscribe({ error: () => {} });
  }

  // ── Master ──
  testar(c: ConfigBoasVindas) { this.aberto.set({ link: c.link, titulo: c.titulo, botao: c.botao, podeFechar: true, teste: true }); }
  configAdmin(): Observable<ConfigBoasVindas> { return this.http.get<ConfigBoasVindas>(`${this.api}/admin/boas-vindas`); }
  salvar(c: ConfigBoasVindas): Observable<ConfigBoasVindas> { return this.http.put<ConfigBoasVindas>(`${this.api}/admin/boas-vindas`, c); }
}
