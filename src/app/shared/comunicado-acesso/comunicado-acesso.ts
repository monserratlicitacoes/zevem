import { ChangeDetectorRef, Component, OnInit, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { AnuncioService, Comunicado } from '../../services/anuncio.service';

// Avisos que surgem no acesso do cliente (criados pelo master em Anúncios e avisos). Mostra um por vez;
// fechar ou clicar no botão marca como visto, e ele não aparece de novo.
// Com `previa`, mostra só esse aviso (o rascunho do master), sem marcar nada nem navegar.
@Component({
  selector: 'app-comunicado-acesso',
  templateUrl: './comunicado-acesso.html',
  styleUrl: './comunicado-acesso.scss',
})
export class ComunicadoAcesso implements OnInit {
  private service = inject(AnuncioService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  previa = input<Comunicado | null>(null);
  fechou = output<void>();

  fila: Comunicado[] = [];
  get atual(): Comunicado | null { return this.previa() ?? this.fila[0] ?? null; }

  ngOnInit() {
    if (this.previa()) return;
    this.service.pendentes().subscribe({ next: (l) => { this.fila = l; this.cdr.detectChanges(); }, error: () => {} });
  }

  imagem(url: string): string { return this.service.urlImagem(url); }

  fechar() {
    if (this.previa()) { this.fechou.emit(); return; }
    const c = this.atual;
    if (!c?.id) return;
    this.service.marcarVisto(c.id).subscribe({ error: () => {} });
    this.fila = this.fila.slice(1);
  }

  abrirLink() {
    if (this.previa()) { this.fechou.emit(); return; } // na prévia o botão não leva a lugar nenhum
    const link = this.atual?.botao_link || '';
    this.fechar();
    if (link.startsWith('/')) this.router.navigateByUrl(link);
    else if (link) window.open(link, '_blank', 'noopener');
  }
}
