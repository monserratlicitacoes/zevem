import { Directive, ElementRef, HostListener, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

// Campo de valor em reais com máscara: sempre duas casas decimais ("14,04", "1.250,00").
// Os dígitos entram pela direita, como em caixa eletrônico: digitar 1 4 0 4 mostra 14,04.
// Com [(ngModel)], o modelo continua sendo número (ou null quando vazio).
// Uso: <input type="text" appMascaraMoeda [(ngModel)]="valor" />
@Directive({
  selector: 'input[appMascaraMoeda]',
  host: { inputmode: 'numeric', autocomplete: 'off' },
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MascaraMoeda), multi: true }],
})
export class MascaraMoeda implements ControlValueAccessor {
  private aoMudar: (v: number | null) => void = () => {};
  private aoTocar: () => void = () => {};

  constructor(private el: ElementRef<HTMLInputElement>) {}

  static formatar(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '';
    return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  writeValue(v: number | null): void {
    this.el.nativeElement.value = MascaraMoeda.formatar(v);
  }

  registerOnChange(fn: (v: number | null) => void): void { this.aoMudar = fn; }
  registerOnTouched(fn: () => void): void { this.aoTocar = fn; }
  setDisabledState(desativado: boolean): void { this.el.nativeElement.disabled = desativado; }

  @HostListener('input')
  aoDigitar() {
    const input = this.el.nativeElement;
    const digitos = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 13);
    const valor = digitos ? Number(digitos) / 100 : null;
    input.value = MascaraMoeda.formatar(valor);
    this.aoMudar(valor);
  }

  @HostListener('blur')
  aoSair() { this.aoTocar(); }
}
