import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RecebimentoService, Recebimento, CLASSES_RECEBIMENTO } from '../../services/recebimento.service';
import { PessoaService, Pessoa } from '../../services/pessoa.service';
import { EtapaService } from '../../services/etapa.service';
import { VideoBadge } from '../../shared/video-badge/video-badge';
import { JarroOrcamento } from '../../shared/jarro-orcamento/jarro-orcamento';
import { ClassificacaoGastos } from '../../shared/classificacao-gastos/classificacao-gastos';

@Component({
  selector: 'app-recebimentos',
  imports: [FormsModule, VideoBadge, ClassificacaoGastos, JarroOrcamento],
  templateUrl: './recebimentos.html',
  styleUrl: './recebimentos.scss',
})
export class Recebimentos implements OnInit {
  jarroAberto = false; // modal "Jarro do Orçamento"
  classes = CLASSES_RECEBIMENTO;
  recebimentos: Recebimento[] = [];
  pessoas: Pessoa[] = [];
  carregando = true;
  adicionando = false;

  linhasMinimas = 0;

  constructor(
    private service: RecebimentoService,
    private pessoaService: PessoaService,
    private etapaService: EtapaService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit() {
    this.carregar();
  }

  carregar() {
    this.carregando = true;
    this.pessoaService.listar().subscribe({ next: (p) => { this.pessoas = p; this.cdr.detectChanges(); } });
    this.service.listar().subscribe({
      next: (lista) => {
        this.recebimentos = lista;
        this.carregando = false;
        if (lista.length > 0) this.etapaService.marcarConcluida('recebimentos');
        this.cdr.detectChanges();
      },
      error: () => { this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  nomeCurto(nome: string): string {
    return nome.trim().split(/\s+/)[0];
  }

  valorMensal(r: Recebimento): number {
    const v = r.valor || 0;
    return r.classe?.startsWith('Eventual') ? Math.round(v / 12) : v;
  }

  get totalMensal(): number {
    return this.recebimentos.reduce((s, r) => s + this.valorMensal(r), 0);
  }

  // ── Dashboard ──────────────────────────────────────────────
  modalAberto = false;
  fluxoAberto = false; // fluxograma da classificação dos recebimentos

  get dashMensal(): number {
    return this.recebimentos
      .filter(r => !r.classe?.startsWith('Eventual'))
      .reduce((s, r) => s + this.valorMensal(r), 0);
  }

  get dashEventual(): number {
    return this.recebimentos
      .filter(r => r.classe?.startsWith('Eventual'))
      .reduce((s, r) => s + this.valorMensal(r), 0);
  }

  pct(valor: number): string {
    const total = this.totalMensal;
    return total > 0 ? `${Math.round((valor / total) * 100)}%` : '0%';
  }

  larguraBar(valor: number): string {
    return this.pct(valor);
  }

  formatarMoedaInput(v: number): string {
    if (!v) return '';
    return Math.round(v).toLocaleString('pt-BR');
  }

  onValorBlur(e: Event, r: Recebimento) {
    const raw = (e.target as HTMLInputElement).value.replace(/[^\d,]/g, '').replace(',', '.');
    r.valor = raw ? Math.round(parseFloat(raw)) : 0;
    (e.target as HTMLInputElement).value = r.valor ? this.formatarMoedaInput(r.valor) : '';
    this.salvarLinha(r);
  }

  get linhasVazias(): number[] {
    const faltam = this.linhasMinimas - this.recebimentos.length;
    return faltam > 0 ? Array.from({ length: faltam }, (_, i) => i) : [];
  }

  adicionarLinha() {
    if (this.adicionando) return;
    this.adicionando = true;
    this.service.criar({ descricao: '', origem: '', classe: '', valor: 0 }).subscribe({
      next: (r) => {
        this.recebimentos = [...this.recebimentos, r];
        this.adicionando = false;
        this.etapaService.marcarConcluida('recebimentos');
        this.cdr.detectChanges();
      },
      error: () => { this.adicionando = false; this.cdr.detectChanges(); },
    });
  }

  salvarLinha(r: Recebimento) {
    if (!r.id) return;
    this.service.atualizar(r.id, r).subscribe({
      next: (atualizado) => {
        const i = this.recebimentos.findIndex(x => x.id === r.id);
        if (i >= 0) this.recebimentos[i] = atualizado;
        this.cdr.detectChanges();
      },
    });
  }

  excluirLinha(r: Recebimento) {
    if (!r.id) return;
    this.service.excluir(r.id).subscribe({
      next: () => {
        this.recebimentos = this.recebimentos.filter(x => x.id !== r.id);
        this.cdr.detectChanges();
      },
    });
  }

  formatarMoeda(v: number): string {
    return Math.round(v || 0).toLocaleString('pt-BR');
  }
}
