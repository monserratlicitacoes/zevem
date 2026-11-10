import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminService, ClienteAdmin } from '../../../services/admin.service';
import { VideosAssistidosService } from '../../../services/videos-assistidos.service';
import { JarroOrcamento, ParteOrcamento } from '../../../shared/jarro-orcamento/jarro-orcamento';

type Coluna = 'nome' | 'renda' | 'patrimonio' | 'saude' | 'comprometimento' | 'videos' | 'ultimo_gasto' | 'utilizacao' | 'acesso';

interface Linha extends ClienteAdmin {
  videosPct: number;
  utilizacao: number; // 0 a 5
}

const TODAS: ParteOrcamento[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

@Component({
  selector: 'app-admin-clientes',
  imports: [FormsModule, JarroOrcamento],
  templateUrl: './admin-clientes.html',
  styleUrls: ['../admin-comum.scss', './admin-clientes.scss'],
})
export class AdminClientes implements OnInit {
  private service = inject(AdminService);
  private videos = inject(VideosAssistidosService);
  private cdr = inject(ChangeDetectorRef);

  readonly todasPartes = TODAS;
  carregando = true;
  erro = '';
  linhas: Linha[] = [];

  // Filtros e ordem
  busca = '';
  estadoCivil: '' | 'casado' | 'solteiro' = '';
  faixaSaude: '' | 'critico' | 'atencao' | 'saudavel' | 'sem' = '';
  utilizacaoMin = 0;
  ordem: Coluna = 'utilizacao';
  crescente = false;

  jarro: Linha | null = null;

  ngOnInit() {
    this.service.clientes().subscribe({
      next: (l) => { this.linhas = l.map((c) => this.montar(c)); this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.erro = 'Não foi possível carregar os clientes.'; this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  // Vídeos: só os do catálogo atual contam. Utilização: média das 5 partes (acesso, lançamentos,
  // cadastro, WhatsApp e vídeos), de 0 a 1 cada, vezes 5.
  private montar(c: ClienteAdmin): Linha {
    const catalogo = new Set(this.videos.todos);
    const vistos = c.videos_assistidos.filter((k) => catalogo.has(k)).length;
    const videosPct = catalogo.size ? Math.round((vistos / catalogo.size) * 100) : 0;
    const p = c.utilizacao_partes;
    const utilizacao = Math.round(((p.acesso + p.lancamentos + p.cadastro + p.whatsapp + videosPct / 100) / 5) * 5 * 10) / 10;
    return { ...c, videosPct, utilizacao };
  }

  get filtradas(): Linha[] {
    const termo = this.normalizar(this.busca);
    const lista = this.linhas.filter((c) => {
      if (termo && !this.normalizar(`${c.nome} ${c.email} ${c.telefone} ${c.pessoas.map((p) => `${p.nome} ${p.telefone}`).join(' ')}`).includes(termo)) return false;
      if (this.estadoCivil && (this.estadoCivil === 'casado') !== c.casado) return false;
      if (this.faixaSaude && this.faixa(c.nivel_saude) !== this.faixaSaude) return false;
      if (c.utilizacao < this.utilizacaoMin) return false;
      return true;
    });
    const valor = (c: Linha): number | string => {
      switch (this.ordem) {
        case 'nome': return this.normalizar(c.nome);
        case 'renda': return c.renda_mensal;
        case 'patrimonio': return c.patrimonio_financeiro;
        case 'saude': return c.nivel_saude ?? -1;
        case 'comprometimento': return c.grau_comprometimento ?? -1;
        case 'videos': return c.videosPct;
        case 'ultimo_gasto': return c.ultimo_gasto?.criado_em ?? '';
        case 'acesso': return c.ultimo_acesso ?? '';
        default: return c.utilizacao;
      }
    };
    return [...lista].sort((a, b) => {
      const x = valor(a), y = valor(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return this.crescente ? r : -r;
    });
  }

  ordenar(c: Coluna) {
    if (this.ordem === c) this.crescente = !this.crescente;
    else { this.ordem = c; this.crescente = c === 'nome'; }
  }
  seta(c: Coluna): string { return this.ordem === c ? (this.crescente ? '↑' : '↓') : ''; }

  // Resumo
  get mediaUtilizacao(): number {
    return this.linhas.length ? Math.round((this.linhas.reduce((t, c) => t + c.utilizacao, 0) / this.linhas.length) * 10) / 10 : 0;
  }
  get ativosSemana(): number {
    return this.linhas.filter((c) => c.ultimo_acesso && Date.now() - Date.parse(c.ultimo_acesso.replace(' ', 'T') + 'Z') <= 7 * 864e5).length;
  }
  get emRisco(): number { return this.linhas.filter((c) => c.nivel_saude !== null && c.nivel_saude <= 3).length; }

  faixa(n: number | null): 'critico' | 'atencao' | 'saudavel' | 'sem' {
    if (n === null) return 'sem';
    return n <= 3 ? 'critico' : n <= 6 ? 'atencao' : 'saudavel';
  }
  classeComprometimento(p: number | null): string {
    if (p === null) return '';
    return p > 60 ? 'critico' : p > 40 ? 'atencao' : 'ok';
  }

  moeda(v: number): string { return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }); }
  data(iso: string | null | undefined): string {
    if (!iso) return '—';
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a.slice(2)}`;
  }
  diasDesde(iso: string | null): string {
    if (!iso) return 'nunca';
    const dias = Math.floor((Date.now() - Date.parse(iso.replace(' ', 'T') + 'Z')) / 864e5);
    return dias <= 0 ? 'hoje' : dias === 1 ? 'ontem' : `há ${dias} dias`;
  }
  private normalizar(t: string): string { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
}
