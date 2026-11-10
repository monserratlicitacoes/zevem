import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { KeyValuePipe } from '@angular/common';
import { BoasVindasService, ConfigBoasVindas } from '../../../services/boas-vindas.service';
import { AnuncioService, CORES_ANUNCIO, ChaveCor, Comunicado, ConfigAnuncio, varsCor } from '../../../services/anuncio.service';
import { LayoutService } from '../../../services/layout.service';
import { ComunicadoAcesso } from '../../../shared/comunicado-acesso/comunicado-acesso';

const AVISO_VAZIO = (): Comunicado => ({
  titulo: '', mensagem: '', imagem_url: '', botao_texto: '', botao_link: '', publico: 'todos', inicio: null, fim: null, ativo: true,
});
const PUBLICOS: Record<string, string> = { todos: 'Todos', assinantes: 'Só assinantes', nao_assinantes: 'Só quem não assina' };

@Component({
  selector: 'app-admin-anuncios',
  imports: [FormsModule, KeyValuePipe, ComunicadoAcesso],
  templateUrl: './admin-anuncios.html',
  styleUrls: ['../admin-comum.scss', './admin-anuncios.scss'],
})
export class AdminAnuncios implements OnInit {
  private service = inject(AnuncioService);
  private layout = inject(LayoutService);
  private bv = inject(BoasVindasService);
  private cdr = inject(ChangeDetectorRef);

  readonly publicos = PUBLICOS;
  anuncio: ConfigAnuncio | null = null;

  // Cores do anúncio (paleta da marca)
  readonly varsCor = varsCor;
  readonly paleta = (Object.keys(CORES_ANUNCIO) as ChaveCor[]).map((chave) => ({ chave, ...CORES_ANUNCIO[chave] }));
  readonly alvosCor: { campo: 'cor_botao_menu' | 'cor_destaque' | 'cor_botao_agendar'; rotulo: string }[] = [
    { campo: 'cor_botao_menu', rotulo: 'Botão do menu' },
    { campo: 'cor_destaque', rotulo: 'Frase de destaque' },
    { campo: 'cor_botao_agendar', rotulo: 'Botão de agendar' },
  ];
  salvandoAnuncio = false;
  msgAnuncio = '';
  erroAnuncio = '';

  // Vídeo de boas-vindas
  boasVindas: ConfigBoasVindas | null = null;
  salvandoBoasVindas = false;
  msgBoasVindas = '';
  erroBoasVindas = '';

  avisos: Comunicado[] = [];
  editando: Comunicado | null = null;
  salvandoAviso = false;
  erroAviso = '';
  enviandoImagem = '';

  ngOnInit() {
    this.service.configAdmin().subscribe((a) => { this.anuncio = a; this.cdr.detectChanges(); });
    this.carregarAvisos();
    this.bv.configAdmin().subscribe((b) => { this.boasVindas = b; this.cdr.detectChanges(); });
  }
  carregarAvisos() { this.service.comunicados().subscribe((l) => { this.avisos = l; this.cdr.detectChanges(); }); }

  imagem(url: string): string { return this.service.urlImagem(url); }

  // ── Anúncio do planejador ──
  adicionarPonto() { this.anuncio?.pontos.push({ titulo: '', texto: '' }); }
  removerPonto(i: number) { this.anuncio?.pontos.splice(i, 1); }

  salvarAnuncio(previa = false) {
    if (!this.anuncio) return;
    this.salvandoAnuncio = true; this.msgAnuncio = ''; this.erroAnuncio = '';
    this.service.salvarAnuncio(this.anuncio).subscribe({
      next: (a) => {
        this.anuncio = a; this.salvandoAnuncio = false; this.msgAnuncio = 'Salvo.';
        if (previa && a.ativo) this.layout.anuncioPlanejador.set(true);
        this.cdr.detectChanges();
      },
      error: (e) => { this.salvandoAnuncio = false; this.erroAnuncio = e?.error?.erro || 'Não foi possível salvar.'; this.cdr.detectChanges(); },
    });
  }

  // ── Vídeo de boas-vindas ──
  salvarBoasVindas() {
    const b = this.boasVindas;
    if (!b) return;
    this.salvandoBoasVindas = true; this.msgBoasVindas = ''; this.erroBoasVindas = '';
    this.bv.salvar(b).subscribe({
      next: (r) => { this.boasVindas = { ...b, ...r }; this.salvandoBoasVindas = false; this.msgBoasVindas = 'Salvo.'; this.cdr.detectChanges(); },
      error: (e) => { this.salvandoBoasVindas = false; this.erroBoasVindas = e?.error?.erro || 'Não foi possível salvar.'; this.cdr.detectChanges(); },
    });
  }
  // Abre o vídeo como o cliente vê (sem salvar nem marcar nada); o master pode fechar
  testarBoasVindas() { if (this.boasVindas) this.bv.testar(this.boasVindas); }

  // ── Imagens (foto do anúncio e dos avisos) ──
  escolherImagem(ev: Event, destino: 'anuncio' | 'aviso') {
    const arquivo = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!arquivo) return;
    if (arquivo.size > 5 * 1024 * 1024) { this.avisoErroImagem(destino, 'Imagem maior que 5 MB.'); return; }
    const leitor = new FileReader();
    leitor.onload = () => {
      this.enviandoImagem = destino;
      this.service.enviarImagem(String(leitor.result)).subscribe({
        next: ({ url }) => {
          if (destino === 'anuncio' && this.anuncio) this.anuncio.foto_url = url;
          if (destino === 'aviso' && this.editando) this.editando.imagem_url = url;
          this.enviandoImagem = ''; this.cdr.detectChanges();
        },
        error: (e) => { this.enviandoImagem = ''; this.avisoErroImagem(destino, e?.error?.erro || 'Não foi possível enviar a imagem.'); },
      });
    };
    leitor.readAsDataURL(arquivo);
  }
  private avisoErroImagem(destino: 'anuncio' | 'aviso', msg: string) {
    if (destino === 'anuncio') this.erroAnuncio = msg; else this.erroAviso = msg;
    this.cdr.detectChanges();
  }

  // ── Avisos de acesso ──
  // Prévia: o rascunho no mesmo componente que o cliente vê, sem salvar
  previa: Comunicado | null = null;
  previsualizar(c: Comunicado) {
    if (!c.titulo.trim()) { this.erroAviso = 'Informe o título para ver a prévia.'; return; }
    this.erroAviso = '';
    this.previa = { ...c, titulo: c.titulo.trim() };
  }

  novoAviso() { this.editando = AVISO_VAZIO(); this.erroAviso = ''; }
  editarAviso(c: Comunicado) { this.editando = { ...c, ativo: !!c.ativo }; this.erroAviso = ''; }
  cancelarAviso() { this.editando = null; }
  salvarAviso() {
    if (!this.editando) return;
    this.salvandoAviso = true; this.erroAviso = '';
    this.service.salvarComunicado(this.editando).subscribe({
      next: () => { this.salvandoAviso = false; this.editando = null; this.carregarAvisos(); },
      error: (e) => { this.salvandoAviso = false; this.erroAviso = e?.error?.erro || 'Não foi possível salvar.'; this.cdr.detectChanges(); },
    });
  }
  excluirAviso(c: Comunicado) {
    if (!c.id || !confirm(`Excluir o aviso "${c.titulo}"?`)) return;
    this.service.excluirComunicado(c.id).subscribe(() => this.carregarAvisos());
  }
  alternarAtivo(c: Comunicado) {
    this.service.salvarComunicado({ ...c, ativo: !c.ativo }).subscribe(() => this.carregarAvisos());
  }

  periodo(c: Comunicado): string {
    const d = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '');
    if (!c.inicio && !c.fim) return 'Sempre';
    if (c.inicio && c.fim) return `${d(c.inicio)} a ${d(c.fim)}`;
    return c.inicio ? `A partir de ${d(c.inicio)}` : `Até ${d(c.fim)}`;
  }
}
