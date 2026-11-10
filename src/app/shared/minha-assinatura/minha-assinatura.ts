import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { KeyValuePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

interface MinhaAssinatura {
  status: 'ativa' | 'inadimplente' | 'cancelada' | 'encerrada';
  plano: string;
  fim_ciclo: string;
  renovacao_automatica: boolean;
  cobrancas: { parcela: number; total_parcelas: number; valor: number; vencimento: string; status: string; link_pagamento: string | null }[];
  pedido_cancelamento: { id: number; motivo: string; criado_em: string } | null;
}

// Quadro "Minha assinatura" (tela Configurações): situação, parcelas e pedido de cancelamento.
// O pedido não cancela na hora: chega ao master (menu Financeiro), que resolve.
@Component({
  selector: 'app-minha-assinatura',
  imports: [FormsModule, KeyValuePipe],
  templateUrl: './minha-assinatura.html',
  styleUrl: './minha-assinatura.scss',
})
export class MinhaAssinaturaQuadro implements OnInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private api = environment.apiUrl;

  carregou = false;
  assinatura: MinhaAssinatura | null = null;
  motivos: Record<string, string> = {};
  pedindo = false;
  motivo = '';
  detalhe = '';
  erro = '';
  enviado = false;

  ngOnInit() { this.carregar(); }

  private carregar() {
    this.http.get<MinhaAssinatura | null>(`${this.api}/minha-assinatura`).subscribe({
      next: (a) => { this.assinatura = a; this.carregou = true; this.cdr.detectChanges(); },
      error: () => { this.carregou = true; this.cdr.detectChanges(); },
    });
  }

  get vigente(): boolean { return !!this.assinatura && ['ativa', 'inadimplente'].includes(this.assinatura.status); }
  get pagas(): number { return this.assinatura?.cobrancas.filter((c) => c.status === 'paga').length ?? 0; }
  get proxima() { return this.assinatura?.cobrancas.find((c) => c.status === 'pendente' || c.status === 'vencida') ?? null; }

  abrirPedido() {
    this.pedindo = true; this.erro = '';
    if (!Object.keys(this.motivos).length) this.http.get<Record<string, string>>(`${this.api}/cancelamento/motivos`).subscribe((m) => { this.motivos = m; this.cdr.detectChanges(); });
  }
  enviarPedido() {
    if (!this.motivo) { this.erro = 'Escolha o motivo.'; return; }
    this.http.post(`${this.api}/minha-assinatura/cancelamento`, { motivo: this.motivo, detalhe: this.detalhe }).subscribe({
      next: () => { this.pedindo = false; this.enviado = true; this.carregar(); },
      error: (e) => { this.erro = e?.error?.erro || 'Não foi possível enviar o pedido.'; this.cdr.detectChanges(); },
    });
  }

  moeda(v: number): string { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  data(iso: string): string { return iso ? iso.slice(0, 10).split('-').reverse().join('/') : ''; }
}
