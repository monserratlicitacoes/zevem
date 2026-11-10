import { Component, ElementRef, effect, inject, computed, signal, untracked, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router, NavigationEnd } from '@angular/router';
import { filter, map, startWith } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';
import { LayoutService } from '../../services/layout.service';
import { VideosAssistidosService } from '../../services/videos-assistidos.service';
import { VIDEOS_ETAPAS, GrupoVideos, VideoEtapa, idYoutube } from './videos-etapas';
import { VideosConfigService } from '../../services/videos-config.service';

const LARGURA_COLAPSADA = 56;
const LARGURA_NORMAL = 340;
// Quando a sidebar esquerda recolhe, ela libera 180px (256 - 76) — o painel de vídeo
// absorve esse espaço para crescer junto, em vez de deixá-lo vazio na tela.
const LARGURA_EXPANDIDA = LARGURA_NORMAL + 180;

@Component({
  selector: 'app-video-panel',
  imports: [],
  templateUrl: './video-panel.html',
  styleUrl: './video-panel.scss',
})
export class VideoPanel {
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);
  layout = inject(LayoutService);
  private assistidos = inject(VideosAssistidosService);
  // Títulos, links e título do painel ajustados pelo master (menu Master → Vídeos)
  cfg = inject(VideosConfigService);
  private player = viewChild<ElementRef<HTMLElement>>('player');

  etapaAtivaId = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url.split('/').filter(Boolean)[0] || ''),
      startWith(this.router.url.split('/').filter(Boolean)[0] || ''),
    ),
    { initialValue: '' },
  );


  // ── Vídeos da etapa (YouTube) ──
  // Mostra a capa até o clique; só então carrega o player (já tocando), no domínio sem cookies.
  // Página com subvídeos lista os títulos no painel; o clique escolhe qual tocar.
  videosPagina = computed(() => VIDEOS_ETAPAS[this.etapaAtivaId()] ?? null);
  // Grupos de nível 1 da página: o principal e, se houver, os "outros"
  grupos = computed<GrupoVideos[]>(() => {
    const p = this.videosPagina();
    return p ? [p, ...(p.outros ?? [])] : [];
  });
  chamada = computed(() => this.cfg.chamada(this.etapaAtivaId(), this.videosPagina()?.chamada));
  temLista = computed(() => this.grupos().length > 1 || this.grupos().some((g) => g.subvideos?.length));
  selecionado = signal<VideoEtapa | null>(null);
  videoAtual = computed(() => this.selecionado() ?? this.videosPagina()?.principal ?? null);
  videoId = computed(() => { const v = this.videoAtual(); return v ? idYoutube(this.cfg.link(this.etapaAtivaId(), v)) : null; });
  tocando = signal(false);
  urlEmbed = computed<SafeResourceUrl | null>(() => {
    const id = this.videoId();
    return id ? this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`) : null;
  });

  constructor() {
    this.cfg.carregar();
    // Trocou de página: volta para a capa do vídeo principal da nova etapa
    effect(() => { this.etapaAtivaId(); this.selecionado.set(null); this.tocando.set(false); });
    // Clique no selo rosa de uma página: toca o vídeo indicado
    effect(() => {
      const p = this.layout.videoPedido();
      if (!p) return;
      const v = untracked(() => this.grupos()).flatMap((g) => [g.principal, ...(g.subvideos ?? [])]).find((x) => x.titulo === p.titulo);
      if (v) untracked(() => this.escolher(v));
      this.layout.videoPedido.set(null);
    });
  }

  tocar() { if (this.videoId()) { this.tocando.set(true); this.marcarAssistido(); } }

  // Escolher um título da lista troca o vídeo e já começa a tocar
  escolher(v: VideoEtapa) {
    this.selecionado.set(v);
    this.tocando.set(!!idYoutube(this.cfg.link(this.etapaAtivaId(), v)));
    if (this.tocando()) this.marcarAssistido();
  }

  // Deu play: o selo de vídeo ligado a este título some (ver VideoBadge)
  private marcarAssistido() {
    const v = this.videoAtual();
    if (v) this.assistidos.marcar(this.etapaAtivaId(), v.titulo);
  }
  ehAtual(v: VideoEtapa): boolean { return this.videoAtual() === v; }
  titulo(v: VideoEtapa): string { return this.cfg.titulo(this.etapaAtivaId(), v); }

  telaCheia() {
    if (!this.videoId()) return;
    this.tocando.set(true);
    this.marcarAssistido();
    // O clique do usuário autoriza a tela cheia; o player entra logo em seguida
    this.player()?.nativeElement.requestFullscreen?.().catch(() => {});
  }

  largura = computed(() => {
    if (this.layout.videoColapsado()) return LARGURA_COLAPSADA;
    return this.layout.sidebarColapsada() ? LARGURA_EXPANDIDA : LARGURA_NORMAL;
  });
}
