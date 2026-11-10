import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { AuthService } from './auth.service';

export interface Etapa {
  id: string;
  numero: number;
  titulo: string;
  icone: string;
}

export const ETAPAS: Etapa[] = [
  { id: 'recebimentos', numero: 1, titulo: 'Recebimentos', icone: '' },
];

const STORAGE_KEY = 'apple-green-etapas-concluidas';

@Injectable({ providedIn: 'root' })
export class EtapaService {
  readonly etapas = ETAPAS;

  private auth = inject(AuthService);
  private concluidas = signal<Set<string>>(this.carregarConcluidas());

  // Progresso separado por usuário: troca junto com quem está logado
  constructor() {
    effect(() => { this.auth.usuarioAtual(); this.concluidas.set(this.carregarConcluidas()); });
  }

  private get storageKey(): string { return `${STORAGE_KEY}:${this.auth.usuarioAtual() ?? ''}`; }

  readonly progresso = computed(() => {
    const total = this.etapas.length;
    const feitas = this.concluidas().size;
    return total > 0 ? Math.round((feitas / total) * 100) : 0;
  });

  private carregarConcluidas(): Set<string> {
    try {
      // Chave antiga (sem usuário): passa para quem estiver logado agora
      const antigo = localStorage.getItem(STORAGE_KEY);
      if (antigo !== null && this.auth.usuarioAtual()) { localStorage.setItem(this.storageKey, antigo); localStorage.removeItem(STORAGE_KEY); }
      const raw = localStorage.getItem(this.storageKey);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  }

  private persistir() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.concluidas()))); } catch {}
  }

  estaConcluida(id: string): boolean {
    return this.concluidas().has(id);
  }

  marcarConcluida(id: string) {
    const atual = new Set(this.concluidas());
    atual.add(id);
    this.concluidas.set(atual);
    this.persistir();
  }

  etapaPorId(id: string): Etapa | undefined {
    return this.etapas.find(e => e.id === id);
  }

  proximaEtapa(idAtual: string): Etapa | undefined {
    const i = this.etapas.findIndex(e => e.id === idAtual);
    return i >= 0 ? this.etapas[i + 1] : undefined;
  }

  etapaAnterior(idAtual: string): Etapa | undefined {
    const i = this.etapas.findIndex(e => e.id === idAtual);
    return i > 0 ? this.etapas[i - 1] : undefined;
  }
}
