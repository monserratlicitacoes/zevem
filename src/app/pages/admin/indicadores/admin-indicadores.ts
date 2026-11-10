import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { AdminService, Financeiro } from '../../../services/admin.service';

@Component({
  selector: 'app-admin-indicadores',
  templateUrl: './admin-indicadores.html',
  styleUrls: ['../admin-comum.scss', './admin-indicadores.scss'],
})
export class AdminIndicadores implements OnInit {
  private service = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);

  carregando = true;
  erro = '';
  dados: Financeiro | null = null;

  ngOnInit() {
    this.service.financeiro().subscribe({
      next: (d) => { this.dados = d; this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.erro = 'Não foi possível carregar os indicadores.'; this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  pct(v: number | null | undefined): string { return v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`; }
  nomeMes(m: string): string {
    const [a, n] = m.split('-').map(Number);
    return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][n - 1]}/${String(a).slice(2)}`;
  }
  moeda(v: number | null | undefined): string {
    return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
