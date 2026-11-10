import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChamadaPainel, VIDEOS_ETAPAS, VideoEtapa, idYoutube } from '../../../shared/video-panel/videos-etapas';
import { ConfigVideos, TITULO_PAINEL_PADRAO, VideosConfigService, chaveVideo } from '../../../services/videos-config.service';

// Todos os vídeos do painel da direita, página por página (estrutura em videos-etapas.ts).
// O master troca título e link de cada um, o texto/link do botão do pé do painel e o título do painel.
const NOMES: Record<string, string> = {
  dashboard: 'Dashboard', recebimentos: 'Recebimentos', gastos: 'Gastos', 'gestao-gastos': 'Gestão de Pagamentos',
  dividas: 'Dívidas', 'ativos-passivos': 'Ativos & Passivos', sonhos: 'Sonhos', alertas: 'Alertas', configuracoes: 'Configurações',
};
const SO_MASTER = new Set(['alertas']);

interface LinhaVideo { chave: string; original: VideoEtapa; titulo: string; link: string; nivel: 1 | 2; }
interface LinhaChamada { original: ChamadaPainel; texto: string; link: string; }
interface PaginaVideos { rota: string; nome: string; situacao: '' | 'desativada' | 'só master'; videos: LinhaVideo[]; chamada: LinhaChamada | null; }

@Component({
  selector: 'app-admin-videos',
  imports: [FormsModule],
  templateUrl: './admin-videos.html',
  styleUrls: ['../admin-comum.scss', './admin-videos.scss'],
})
export class AdminVideos implements OnInit {
  private service = inject(VideosConfigService);
  private cdr = inject(ChangeDetectorRef);
  private rotas = new Set(inject(Router).config.map((r) => r.path));

  readonly tituloPadrao = TITULO_PAINEL_PADRAO;
  tituloPainel = '';
  paginas: PaginaVideos[] = [];
  busca = '';
  salvando = false;
  msg = '';
  erro = '';

  carregando = true;

  ngOnInit() {
    this.service.buscar().subscribe({
      next: (c) => { this.montar(c); this.carregando = false; this.cdr.detectChanges(); },
      error: () => { this.erro = 'Não foi possível carregar os vídeos.'; this.carregando = false; this.cdr.detectChanges(); },
    });
  }

  private montar(c: ConfigVideos) {
    this.tituloPainel = c.titulo_painel;
    this.paginas = Object.entries(VIDEOS_ETAPAS).map(([rota, p]) => {
      const linha = (v: VideoEtapa, nivel: 1 | 2): LinhaVideo => {
        const chave = chaveVideo(rota, v.titulo);
        const a = c.videos[chave];
        return { chave, original: v, nivel, titulo: a?.titulo || v.titulo, link: a && a.link !== undefined ? a.link : v.link };
      };
      const videos = [p, ...(p.outros ?? [])].flatMap((g) => [linha(g.principal, 1), ...(g.subvideos ?? []).map((v) => linha(v, 2))]);
      const ac = c.chamadas[rota];
      return {
        rota, nome: NOMES[rota] ?? rota,
        situacao: !this.rotas.has(rota) ? 'desativada' : SO_MASTER.has(rota) ? 'só master' : '',
        videos,
        chamada: p.chamada ? { original: p.chamada, texto: ac?.texto || p.chamada.texto, link: ac && ac.link !== undefined ? ac.link : p.chamada.link } : null,
      };
    });
  }

  // ── Lista ──
  get visiveis(): PaginaVideos[] {
    const t = this.normalizar(this.busca);
    if (!t) return this.paginas;
    return this.paginas
      .map((p) => ({ ...p, videos: this.normalizar(p.nome).includes(t) ? p.videos : p.videos.filter((v) => this.normalizar(`${v.titulo} ${v.original.titulo}`).includes(t)) }))
      .filter((p) => p.videos.length);
  }
  get total(): number { return this.paginas.reduce((n, p) => n + p.videos.length, 0); }
  get semVideo(): number { return this.paginas.reduce((n, p) => n + p.videos.filter((v) => !v.link).length, 0); }
  get comErro(): number { return this.paginas.reduce((n, p) => n + p.videos.filter((v) => !this.linkOk(v.link)).length, 0); }

  linkOk(l: string): boolean { return !l || !!idYoutube(l); }
  miniatura(l: string): string | null { const id = idYoutube(l); return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null; }
  alterado(v: LinhaVideo): boolean { return v.titulo !== v.original.titulo || v.link !== v.original.link; }
  restaurar(v: LinhaVideo) { v.titulo = v.original.titulo; v.link = v.original.link; }

  // ── Salvar: guarda só o que difere do padrão do app ──
  salvar() {
    if (this.comErro) { this.erro = 'Corrija os links marcados em vermelho (precisam ser do YouTube).'; return; }
    const cfg: ConfigVideos = { titulo_painel: this.tituloPainel.trim(), videos: {}, chamadas: {} };
    for (const p of this.paginas) {
      for (const v of p.videos) {
        const a: { titulo?: string; link?: string } = {};
        const t = v.titulo.trim();
        if (t && t !== v.original.titulo) a.titulo = t;
        if (v.link.trim() !== v.original.link) a.link = v.link.trim();
        if (Object.keys(a).length) cfg.videos[v.chave] = a;
      }
      const c = p.chamada;
      if (c) {
        const a: Partial<ChamadaPainel> = {};
        if (c.texto.trim() && c.texto.trim() !== c.original.texto) a.texto = c.texto.trim();
        if (c.link.trim() !== c.original.link) a.link = c.link.trim();
        if (Object.keys(a).length) cfg.chamadas[p.rota] = a as ChamadaPainel;
      }
    }
    this.salvando = true; this.msg = ''; this.erro = '';
    this.service.salvar(cfg).subscribe({
      next: (r) => { this.salvando = false; this.montar(r); this.msg = 'Salvo. Os clientes já veem os vídeos novos.'; this.cdr.detectChanges(); },
      error: (e) => { this.salvando = false; this.erro = e?.error?.erro || 'Não foi possível salvar.'; this.cdr.detectChanges(); },
    });
  }

  private normalizar(t: string): string { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
}
