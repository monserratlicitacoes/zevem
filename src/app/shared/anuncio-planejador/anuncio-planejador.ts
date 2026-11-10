import { ChangeDetectorRef, Component, HostListener, OnInit, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { MascaraMoeda } from '../mascara-moeda';
import { AnuncioService, varsCor } from '../../services/anuncio.service';

// "Contrate um planejador": anúncio aberto pelo botão da barra lateral. Textos, foto e WhatsApp vêm da
// configuração do master (menu Anúncios e avisos). O formulário vem preenchido com o que o app já sabe
// (GET /perfil/diagnostico) e o botão abre o WhatsApp do planejador com a mensagem pronta.
// Sem foto configurada, usa public/planejador.jpg; sem esse arquivo, o símbolo da marca.
const FOTO_PADRAO = '/planejador.jpg';

interface Diagnostico {
  nome: string;
  estado_civil: '' | 'solteiro' | 'casado';
  renda_mensal: number | null;
  investimentos: '' | 'sim' | 'nao';
  profissao: string;
}

@Component({
  selector: 'app-anuncio-planejador',
  imports: [FormsModule, MascaraMoeda],
  templateUrl: './anuncio-planejador.html',
  styleUrl: './anuncio-planejador.scss',
})
export class AnuncioPlanejador implements OnInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private anuncios = inject(AnuncioService);
  readonly config = this.anuncios.anuncio;
  readonly varsCor = varsCor; // cores da faixa de destaque e do botão (escolhidas pelo master)

  fechar = output<void>();

  get foto(): string { return this.anuncios.urlImagem(this.config()?.foto_url || '') || FOTO_PADRAO; }
  fotoFalhou = false;
  form: Diagnostico = { nome: '', estado_civil: '', renda_mensal: null, investimentos: '', profissao: '' };
  enviado = false;

  ngOnInit() {
    if (!this.config()) this.anuncios.carregar();
    this.http.get<Diagnostico>(`${environment.apiUrl}/perfil/diagnostico`).subscribe({
      next: (d) => { this.form = { ...d, renda_mensal: d.renda_mensal || null }; this.cdr.detectChanges(); },
      error: () => { /* sem pré-preenchimento: o formulário fica em branco */ },
    });
  }

  @HostListener('document:keydown.escape')
  aoEsc() { this.fechar.emit(); }

  get completo(): boolean {
    const f = this.form;
    return !!(f.nome.trim() && f.estado_civil && f.renda_mensal && f.investimentos && f.profissao.trim());
  }

  // Abre a conversa com a mensagem pronta e as respostas do formulário
  agendar() {
    this.enviado = true;
    if (!this.completo) return;
    const f = this.form;
    const renda = Number(f.renda_mensal).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
    const c = this.config();
    if (!c?.whatsapp) return;
    const texto = [
      c.mensagem.replace(/\{nome\}/g, f.nome.trim()),
      '',
      `Estado civil: ${f.estado_civil === 'casado' ? 'casado(a)' : 'solteiro(a)'}`,
      `Renda mensal familiar: ${renda}`,
      `Já investe no mercado financeiro: ${f.investimentos === 'sim' ? 'sim' : 'não'}`,
      `Profissão: ${f.profissao.trim()}`,
    ].join('\n');
    window.open(`https://wa.me/${c.whatsapp}?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  }
}
