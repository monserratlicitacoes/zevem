import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminService, Cupom } from '../../../services/admin.service';

// Master › Cupons: cupons de desconto do checkout (/checkout). O desconto vale só para o 1º ano;
// a renovação volta ao preço do plano. Cupom já usado não é excluído, só desativado.
@Component({
  selector: 'app-admin-cupons',
  imports: [FormsModule],
  templateUrl: './admin-cupons.html',
  styleUrls: ['../admin-comum.scss', './admin-cupons.scss'],
})
export class AdminCupons implements OnInit {
  private service = inject(AdminService);
  private cdr = inject(ChangeDetectorRef);

  carregando = true;
  erro = '';
  cupons: Cupom[] = [];
  plano: { nome: string; valor_anual: number; parcelas: number; valor_parcela: number } | null = null;

  editando: Cupom | null = null;
  erroEdicao = '';
  salvando = false;

  ngOnInit() { this.carregar(); }

  carregar() {
    this.service.cupons().subscribe({
      next: (r) => { this.cupons = r.cupons; this.plano = r.plano; this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.erro = 'Não foi possível carregar os cupons.'; this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  get valendo(): number { return this.cupons.filter((c) => c.situacao === 'valendo').length; }
  get vendas(): number { return this.cupons.reduce((t, c) => t + (c.usos || 0), 0); }

  novo() {
    this.editando = { codigo: '', tipo: 'percentual', valor: 10, valido_ate: null, limite_usos: null, descricao: '', ativo: true };
    this.erroEdicao = '';
  }
  editar(c: Cupom) { this.editando = { ...c }; this.erroEdicao = ''; }

  // Prévia do preço com o cupom em edição (mesma regra do backend: parcela mínima de R$ 5 no Asaas)
  get previa(): { total: number; parcela: number } | null {
    const c = this.editando;
    if (!c || !this.plano || !(Number(c.valor) > 0)) return null;
    const p = this.plano;
    const desconto = c.tipo === 'valor' ? Number(c.valor) : (p.valor_anual * Number(c.valor)) / 100;
    const total = Math.round(Math.max(p.valor_anual - desconto, p.parcelas * 5) * 100) / 100;
    return { total, parcela: Math.round((total / p.parcelas) * 100) / 100 };
  }

  salvar() {
    const c = this.editando;
    if (!c) return;
    c.codigo = String(c.codigo || '').trim().toUpperCase().replace(/\s+/g, '');
    this.salvando = true;
    this.service.salvarCupom({ ...c, valido_ate: c.valido_ate || null, limite_usos: c.limite_usos || null }).subscribe({
      next: () => { this.salvando = false; this.editando = null; this.carregar(); },
      error: (e) => { this.salvando = false; this.erroEdicao = e?.error?.erro || 'Não foi possível salvar o cupom.'; this.cdr.detectChanges(); },
    });
  }

  alternar(c: Cupom) {
    this.service.salvarCupom({ ...c, ativo: !c.ativo }).subscribe({
      next: () => this.carregar(),
      error: (e) => alert(e?.error?.erro || 'Não foi possível mudar o cupom.'),
    });
  }

  excluir(c: Cupom) {
    if (!c.id || !confirm(`Excluir o cupom ${c.codigo}?`)) return;
    this.service.excluirCupom(c.id).subscribe({
      next: () => this.carregar(),
      error: (e) => alert(e?.error?.erro || 'Não foi possível excluir o cupom.'),
    });
  }

  desconto(c: Cupom): string {
    return c.tipo === 'valor' ? `${this.moeda(c.valor)} no ano` : `${String(c.valor).replace('.', ',')}%`;
  }
  moeda(v: number | null | undefined): string {
    return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  data(iso: string | null | undefined): string { return iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—'; }
}
