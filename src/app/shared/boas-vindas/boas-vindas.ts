import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, ViewChild, inject, input } from '@angular/core';
import { BoasVindasService, SessaoBoasVindas } from '../../services/boas-vindas.service';
import { idYoutube } from '../video-panel/videos-etapas';

// Vídeo de boas-vindas em tela cheia (desenhado na raiz do app, por cima de tudo).
// Usa a API de player do YouTube para saber quando o vídeo termina; sem controles de avanço, para o
// cliente assistir até o fim. Cliente não fecha: o botão aparece no fim e libera o app.
// Master (ou teste) fecha clicando fora, no X ou com Esc.
const API_YOUTUBE = 'https://www.youtube.com/iframe_api';
let apiYoutube: Promise<any> | null = null;

function carregarApiYoutube(): Promise<any> {
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (apiYoutube) return apiYoutube;
  apiYoutube = new Promise((ok, falha) => {
    const anterior = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { anterior?.(); ok(w.YT); };
    const s = document.createElement('script');
    s.src = API_YOUTUBE;
    s.async = true;
    s.onerror = () => { apiYoutube = null; falha(new Error('API do YouTube indisponível')); };
    document.head.appendChild(s);
  });
  return apiYoutube;
}

@Component({
  selector: 'app-boas-vindas',
  templateUrl: './boas-vindas.html',
  styleUrl: './boas-vindas.scss',
})
export class BoasVindas implements AfterViewInit, OnDestroy {
  private service = inject(BoasVindasService);
  private cdr = inject(ChangeDetectorRef);

  sessao = input.required<SessaoBoasVindas>();
  @ViewChild('alvo') alvo!: ElementRef<HTMLDivElement>;

  private player: any = null;
  private relogio: ReturnType<typeof setInterval> | null = null;
  private limite: ReturnType<typeof setTimeout> | null = null;

  terminou = false;   // vídeo chegou ao fim: mostra o botão
  falhou = false;     // vídeo não carregou: libera o botão para ninguém ficar preso
  tocando = false;
  progresso = 0;      // 0–100
  restante = '';

  ngAfterViewInit() {
    const id = idYoutube(this.sessao().link);
    if (!id) { this.liberarPorFalha(); return; }
    // Se o player não ficar pronto em 20 s (rede, bloqueador), libera o botão
    this.limite = setTimeout(() => { if (!this.player?.getDuration?.()) this.liberarPorFalha(); }, 20000);
    carregarApiYoutube().then((YT) => {
      this.player = new YT.Player(this.alvo.nativeElement, {
        host: 'https://www.youtube-nocookie.com',
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1 },
        events: {
          onStateChange: (e: { data: number }) => {
            this.tocando = e.data === YT.PlayerState.PLAYING;
            if (e.data === YT.PlayerState.ENDED) { this.terminou = true; this.progresso = 100; this.restante = ''; }
            this.cdr.detectChanges();
          },
          onError: () => this.liberarPorFalha(),
        },
      });
      this.relogio = setInterval(() => this.atualizarTempo(), 500);
    }).catch(() => this.liberarPorFalha());
  }

  ngOnDestroy() {
    if (this.relogio) clearInterval(this.relogio);
    if (this.limite) clearTimeout(this.limite);
    try { this.player?.destroy?.(); } catch { /* player já fechado */ }
  }

  private atualizarTempo() {
    const p = this.player;
    if (!p?.getDuration || this.terminou) return;
    const total = p.getDuration() || 0;
    const atual = p.getCurrentTime() || 0;
    if (!total) return;
    this.progresso = Math.min(100, (atual / total) * 100);
    const falta = Math.max(0, Math.ceil(total - atual));
    this.restante = `${Math.floor(falta / 60)}:${String(falta % 60).padStart(2, '0')}`;
    this.cdr.detectChanges();
  }

  private liberarPorFalha() {
    if (this.terminou) return;
    this.falhou = true;
    this.terminou = true;
    this.cdr.detectChanges();
  }

  alternar() {
    if (!this.player?.getPlayerState || this.terminou) return;
    if (this.tocando) this.player.pauseVideo(); else this.player.playVideo();
  }

  rever() {
    if (!this.player?.seekTo) return;
    this.terminou = false; this.progresso = 0;
    this.player.seekTo(0, true); this.player.playVideo();
  }

  comecar() { this.service.concluir(); }

  // Só o master (ou o teste) sai antes do fim
  fecharFora() { if (this.sessao().podeFechar) this.service.concluir(); }
  @HostListener('document:keydown.escape') esc() { this.fecharFora(); }
}
