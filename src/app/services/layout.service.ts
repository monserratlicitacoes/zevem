import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly sidebarColapsada = signal(false);
  readonly videoColapsado = signal(false);
  // Anúncio "Contrate um planejador": aberto pelo botão do menu, desenhado na raiz do app (app.html)
  // para ficar por cima de tudo
  readonly anuncioPlanejador = signal(false);
  // Clique no selo rosa de vídeo: o painel da direita abre e toca este vídeo (título original em
  // videos-etapas.ts). O "pedido" muda a cada clique, para repetir o mesmo vídeo funcionar.
  readonly videoPedido = signal<{ titulo: string; pedido: number } | null>(null);

  abrirVideo(titulo: string) {
    this.videoPedido.set({ titulo, pedido: Date.now() });
    if (this.videoColapsado()) this.toggleVideo();
  }

  toggleSidebar() {
    this.sidebarColapsada.update(v => !v);
  }

  // Expandir o painel de vídeo recolhe a sidebar esquerda automaticamente, para abrir espaço.
  // O caminho de volta é manual: só volta ao normal quando o usuário expandir a sidebar esquerda de novo.
  toggleVideo() {
    const expandindo = this.videoColapsado();
    this.videoColapsado.set(!expandindo);
    if (expandindo) {
      this.sidebarColapsada.set(true);
    }
  }
}
