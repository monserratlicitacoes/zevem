import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Sidebar } from './shared/sidebar/sidebar';
import { VideoPanel } from './shared/video-panel/video-panel';
import { AuthService } from './services/auth.service';
import { TemaService } from './services/tema.service';
import { LayoutService } from './services/layout.service';
import { AnuncioPlanejador } from './shared/anuncio-planejador/anuncio-planejador';
import { ComunicadoAcesso } from './shared/comunicado-acesso/comunicado-acesso';
import { BoasVindas } from './shared/boas-vindas/boas-vindas';
import { BoasVindasService } from './services/boas-vindas.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Sidebar, VideoPanel, AnuncioPlanejador, ComunicadoAcesso, BoasVindas],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  // TemaService aplica a versão noturna em todo o app assim que ele abre
  constructor(public auth: AuthService, public layout: LayoutService, public boasVindas: BoasVindasService, _tema: TemaService) {}
}
