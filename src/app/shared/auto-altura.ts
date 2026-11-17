import { AfterViewInit, Directive, ElementRef, HostListener, Input, OnDestroy, Optional } from '@angular/core';
import { NgModel } from '@angular/forms';
import { Subscription } from 'rxjs';

// Caixa de texto de uma linha que cresce em altura quando o texto não cabe na largura da coluna,
// até `autoAlturaMax` linhas (padrão 2). O que passar disso fica cortado com um esmaecido no fim
// e aparece inteiro ao passar o mouse (title); durante a edição, rola dentro das 2 linhas.
// Enter não quebra linha: sai do campo (dispara o blur, que salva).
@Directive({ selector: 'textarea[autoAltura]' })
export class AutoAltura implements AfterViewInit, OnDestroy {
  @Input() autoAlturaMax = 2;
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
  @HostListener('blur')
  ajustar() {
    const t = this.el.nativeElement;
    const estilo = getComputedStyle(t);
    const linha = parseFloat(estilo.lineHeight) || 18;
    const respiro = parseFloat(estilo.paddingTop) + parseFloat(estilo.paddingBottom);
    const maximo = Math.ceil(linha * this.autoAlturaMax + respiro);
    t.style.height = 'auto';
    const precisa = t.scrollHeight;
    t.style.height = `${Math.min(precisa, maximo)}px`;
    // Direto no elemento: o ajuste roda fora dos eventos do Angular (timers, ResizeObserver)
    const cortado = precisa > maximo + 1;
    t.classList.toggle('cortado', cortado);
    if (cortado) t.title = t.value; else t.removeAttribute('title');
    // Fora da edição volta ao começo do texto (a rolagem da edição não fica pela metade)
    if (document.activeElement !== t) t.scrollTop = 0;
  }

  @HostListener('keydown.enter', ['$event'])
  aoEnter(e: Event) {
    e.preventDefault();
    this.el.nativeElement.blur();
  }
}
