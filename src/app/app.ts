import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { Sidebar } from './shared/sidebar/sidebar';
import { VideoPanel } from './shared/video-panel/video-panel';
import { AuthService } from './services/auth.service';
import { TemaService } from './services/tema.service';
import { LayoutService } from './services/layout.service';
import { AnuncioPlanejador } from './shared/anuncio-planejador/anuncio-planejador';
import { ComunicadoAcesso } from './shared/comunicado-acesso/comunicado-acesso';
import { BoasVindas } from './shared/boas-vindas/boas-vindas';
import { BoasVindasService } from './services/boas-vindas.service';

// Telas de entrada: abrem sem menu nem vídeos mesmo com alguém logado no navegador
// (ex.: o master abrindo um link de convite para testar)
const ROTAS_PUBLICAS = ['/login', '/cadastro', '/confirmar-email', '/redefinir-senha', '/assinar', '/checkout'];
const semQuery = (url: string) => url.split(/[?#]/)[0];
// Telas das áreas Master e Planejador
const ROTAS_SEM_VIDEO = ['/admin', '/planejador', '/alertas'];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Sidebar, VideoPanel, AnuncioPlanejador, ComunicadoAcesso, BoasVindas],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private router = inject(Router);
  // Caminho atual, sem query nem âncora
  private readonly rota = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => semQuery((e as NavigationEnd).urlAfterRedirects))),
    { initialValue: semQuery(location.pathname) },
  );
  readonly telaPublica = computed(() => ROTAS_PUBLICAS.includes(this.rota()));
  // Vídeos de passo a passo só nas telas do menu do cliente: nunca para o planejador
  // e, para o master, só quando ele está usando o app como cliente (fora da área Master)
  readonly mostrarVideo = computed(() => !this.auth.planejador() && !ROTAS_SEM_VIDEO.some((r) => this.rota() === r || this.rota().startsWith(r + '/')));

  // TemaService aplica a versão noturna em todo o app assim que ele abre
  constructor(public auth: AuthService, public layout: LayoutService, public boasVindas: BoasVindasService, _tema: TemaService) {}
}
