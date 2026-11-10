import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { VideosAssistidosService } from '../../services/videos-assistidos.service';
import { LayoutService } from '../../services/layout.service';
import { VIDEOS_ETAPAS } from '../video-panel/videos-etapas';

// Selo de "play" reutilizável: indica que o elemento onde está encaixado leva a um vídeo.
// Uso: coloque <app-video-badge /> dentro de um elemento com position: relative.
// `video` é o título (ou os títulos) em videos-etapas.ts da página atual; sem ele, vale o vídeo
// principal da página. O selo some quando a pessoa já assistiu a todos os vídeos indicados.
// Clicar no selo abre o painel de vídeo da direita já no vídeo indicado (o primeiro ainda não assistido).
@Component({
  selector: 'app-video-badge',
  imports: [],
  templateUrl: './video-badge.html',
  styleUrl: './video-badge.scss',
})
export class VideoBadge {
  private assistidos = inject(VideosAssistidosService);
  private layout = inject(LayoutService);
  // O selo vive dentro da página: a rota não muda enquanto ele existe
  private rota = inject(Router).url.split(/[/?#]/).filter(Boolean)[0] || '';

  video = input<string | string[]>();

  private titulos = computed(() => {
    const v = this.video();
    return v === undefined ? [VIDEOS_ETAPAS[this.rota]?.principal.titulo].filter((t): t is string => !!t) : ([] as string[]).concat(v);
  });
  visivel = computed(() => !this.titulos().length || this.titulos().some((t) => !this.assistidos.assistido(this.rota, t)));

  // O selo fica dentro de botões e abas: o clique nele não aciona o elemento de fora
  abrir(ev: Event) {
    ev.preventDefault();
    ev.stopPropagation();
    const titulos = this.titulos();
    const alvo = titulos.find((t) => !this.assistidos.assistido(this.rota, t)) ?? titulos[0];
    if (alvo) this.layout.abrirVideo(alvo);
  }
}
