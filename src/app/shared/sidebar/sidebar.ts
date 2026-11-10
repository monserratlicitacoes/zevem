import { Component, OnInit, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { LayoutService } from '../../services/layout.service';
import { VideosAssistidosService } from '../../services/videos-assistidos.service';
import { AnuncioService, varsCor } from '../../services/anuncio.service';
import { BoasVindasService } from '../../services/boas-vindas.service';

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar implements OnInit {
  // Seção Principal do master: fechada por padrão, aberta só para testes
  readonly principalAberto = signal(false);
  readonly varsCor = varsCor; // cor do botão do planejador (escolhida pelo master)
  // Barra de rolagem do menu: visível só enquanto rola, some 900 ms depois do último movimento
  readonly rolando = signal(false);
  private fimRolagem?: ReturnType<typeof setTimeout>;

  constructor(public auth: AuthService, public layout: LayoutService, public videos: VideosAssistidosService, public anuncios: AnuncioService, private boasVindas: BoasVindasService) {}

  ngOnInit() {
    this.auth.carregarPapel().subscribe(); // mostra o grupo Master só para o master
    this.anuncios.carregar();             // texto do botão do planejador (e se ele aparece)
    this.boasVindas.carregar();           // vídeo de boas-vindas no primeiro acesso
  }

  aoRolar() {
    this.rolando.set(true);
    clearTimeout(this.fimRolagem);
    this.fimRolagem = setTimeout(() => this.rolando.set(false), 900);
  }
}
