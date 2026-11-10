import { Injectable, effect, signal } from '@angular/core';
import { cssNoturno } from './tema-noturno-cores';

// Versão noturna do app inteiro. Liga e desliga pelo botão do Dashboard e fica lembrada neste
// navegador. Com ela ligada, <html> recebe a classe "tema-noturno": as cores escuras de cada tela
// são geradas a partir das folhas de estilo (tema-noturno-cores.ts) e os acertos finos ficam em
// src/tema-noturno.scss.
const CHAVE_TEMA = 'ag-dashboard-noturno'; // mesma chave de quando o tema valia só no Dashboard
const ID_ESTILO = 'ag-tema-noturno-gerado';

@Injectable({ providedIn: 'root' })
export class TemaService {
  readonly noturno = signal(lerTema());

  private estilo: HTMLStyleElement | null = null;
  private lidas = new WeakSet<Node>();

  constructor() {
    effect(() => {
      const ligado = this.noturno();
      if (ligado) this.prepararEstilo();
      document.documentElement.classList.toggle('tema-noturno', ligado);
      try { localStorage.setItem(CHAVE_TEMA, ligado ? '1' : '0'); } catch { /* sem armazenamento: vale só nesta visita */ }
    });
  }

  alternar() { this.noturno.update((v) => !v); }

  // Gera o CSS escuro das folhas já carregadas e acompanha as que o Angular adiciona ao abrir
  // outras telas (cada componente injeta o próprio <style> na primeira vez que aparece).
  private prepararEstilo() {
    if (this.estilo) return;
    this.estilo = document.createElement('style');
    this.estilo.id = ID_ESTILO;
    document.head.appendChild(this.estilo);
    this.lerNovas();
    new MutationObserver(() => this.lerNovas()).observe(document.head, { childList: true });
  }

  private lerNovas() {
    let novo = '';
    for (const folha of Array.from(document.styleSheets)) {
      const dono = folha.ownerNode;
      if (!dono || dono === this.estilo || this.lidas.has(dono)) continue;
      this.lidas.add(dono);
      if (ehDoDashboard(folha)) continue; // o Dashboard tem a versão noturna própria
      novo += cssNoturno(folha, null);
    }
    if (novo && this.estilo) {
      this.estilo.textContent += novo;
      document.head.appendChild(this.estilo); // sempre por último
    }
  }
}

function ehDoDashboard(folha: CSSStyleSheet): boolean {
  try { return Array.from(folha.cssRules).some((r) => r instanceof CSSStyleRule && /\.noturno\[_ngcontent/.test(r.selectorText)); }
  catch { return false; }
}

function lerTema(): boolean {
  try { return localStorage.getItem(CHAVE_TEMA) === '1'; } catch { return false; }
}
