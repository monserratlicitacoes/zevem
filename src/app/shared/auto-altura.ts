import { AfterViewInit, Directive, ElementRef, HostListener, OnDestroy, Optional } from '@angular/core';
import { NgModel } from '@angular/forms';
import { Subscription } from 'rxjs';

// Caixa de texto de uma linha que cresce em altura quando o texto não cabe na largura da coluna.
// Enter não quebra linha: sai do campo (dispara o blur, que salva).
@Directive({ selector: 'textarea[autoAltura]' })
export class AutoAltura implements AfterViewInit, OnDestroy {
  private observador?: ResizeObserver;
  private mudancas?: Subscription;
  private larguraAnterior = 0;

  constructor(private el: ElementRef<HTMLTextAreaElement>, @Optional() private modelo: NgModel | null) {}

  ngAfterViewInit() {
    // O ngModel escreve o valor depois da criação do elemento; ajusta no ciclo seguinte
    setTimeout(() => this.ajustar());
    // A quebra de linha muda quando a fonte termina de carregar
    document.fonts?.ready.then(() => this.ajustar());
    // Valor trocado pelo código (ex.: resposta do servidor depois de salvar)
    this.mudancas = this.modelo?.valueChanges?.subscribe(() => setTimeout(() => this.ajustar()));
    // A largura da coluna muda com a janela e com o painel de vídeo (só a largura importa aqui)
    this.observador = new ResizeObserver(() => {
      const largura = this.el.nativeElement.clientWidth;
      if (largura === this.larguraAnterior) return;
      this.larguraAnterior = largura;
      // Fora do callback: mudar a altura dentro dele gera o aviso "ResizeObserver loop"
      requestAnimationFrame(() => this.ajustar());
    });
    this.observador.observe(this.el.nativeElement);
  }

  ngOnDestroy() {
    this.observador?.disconnect();
    this.mudancas?.unsubscribe();
  }

  @HostListener('input')
  ajustar() {
    const t = this.el.nativeElement;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }

  @HostListener('keydown.enter', ['$event'])
  aoEnter(e: Event) {
    e.preventDefault();
    this.el.nativeElement.blur();
  }
}
