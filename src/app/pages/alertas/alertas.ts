import { ChangeDetectorRef, Component, ElementRef, OnInit, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AlertasService, Aviso, ConfigAlerta, ConfigAlertas, ItemAlerta, PessoaWhatsapp, TextoAlerta } from '../../services/alertas.service';
import { VideoBadge } from '../../shared/video-badge/video-badge';

interface MensagemChat { de: 'pessoa' | 'app'; texto: string; nome?: string; }

// Antecedências oferecidas em cada alerta de data (0 = no dia)
const ANTECEDENCIAS = [7, 5, 3, 2, 1, 0];
const STATUS_AVISO: Record<string, string> = {
  pendente: 'Na fila', reservado: 'Enviando', enviado: 'Enviado', falhou: 'Falhou',
  sem_canal: 'Só no app', sem_destino: 'Sem telefone', expirado: 'Expirado',
};

@Component({
  selector: 'app-alertas',
  imports: [FormsModule, RouterLink, VideoBadge],
  templateUrl: './alertas.html',
  styleUrl: './alertas.scss',
})
export class Alertas implements OnInit {
  private service = inject(AlertasService);
  private cdr = inject(ChangeDetectorRef);
  private chatFim = viewChild<ElementRef<HTMLElement>>('chatFim');

  readonly antecedencias = ANTECEDENCIAS;
  readonly diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  readonly horas = Array.from({ length: 15 }, (_, i) => i + 8); // 8h às 22h
  readonly percentuais = [50, 80, 90, 100];

  carregando = true;
  erro = '';
  dados: ConfigAlertas | null = null;
  salvos = new Set<string>();      // tipos com "Salvo" visível
  erroSalvar: Record<string, string> = {};
  private timers: Record<string, ReturnType<typeof setTimeout>> = {};

  // Escolha dos itens do "Quanto ainda posso gastar"
  itensAbertos = false;
  buscaItem = '';

  // Simulador
  chat: MensagemChat[] = [];
  textoChat = '';
  pessoaChat: number | null = null;
  enviando = false;

  avisos: Aviso[] = [];

  // Textos das mensagens (master; valem para todos os clientes)
  textos: Record<string, TextoAlerta> = {};
  textoAberto: string | null = null;
  rascunho = '';
  msgTexto = '';
  erroTexto = '';

  ngOnInit() {
    this.service.textos().subscribe({ next: (l) => { this.textos = Object.fromEntries(l.map((t) => [t.tipo, t])); this.cdr.detectChanges(); }, error: () => {} });
    this.service.config().subscribe({
      next: (d) => {
        this.dados = d;
        this.pessoaChat = d.pessoas[0]?.id ?? null;
        this.carregando = false;
        this.cdr.detectChanges();
      },
      error: () => { this.erro = 'Não foi possível carregar os alertas.'; this.carregando = false; this.cdr.detectChanges(); },
    });
    this.carregarAvisos();
  }

  carregarAvisos() {
    this.service.avisos(30).subscribe((a) => { this.avisos = a; this.cdr.detectChanges(); });
  }

  get pessoasComTelefone(): PessoaWhatsapp[] { return this.dados?.pessoas.filter((p) => p.tem_telefone) ?? []; }
  get pessoasSemTelefone(): PessoaWhatsapp[] { return this.dados?.pessoas.filter((p) => !p.tem_telefone) ?? []; }

  // ── Edição (salva sozinho, meio segundo depois da última mudança) ──
  alterar(c: ConfigAlerta) {
    clearTimeout(this.timers[c.tipo]);
    this.salvos.delete(c.tipo);
    this.timers[c.tipo] = setTimeout(() => this.salvar(c), 500);
  }

  private salvar(c: ConfigAlerta) {
    this.service.salvar(c).subscribe({
      next: (r) => {
        Object.assign(c, { ativo: r.ativo, parametros: r.parametros, destinatarios: r.destinatarios });
        delete this.erroSalvar[c.tipo];
        this.salvos.add(c.tipo);
        this.cdr.detectChanges();
        setTimeout(() => { this.salvos.delete(c.tipo); this.cdr.detectChanges(); }, 2000);
      },
      error: (e) => { this.erroSalvar[c.tipo] = e?.error?.erro || 'Não foi possível salvar.'; this.cdr.detectChanges(); },
    });
  }

  alternarAtivo(c: ConfigAlerta) { c.ativo = !c.ativo; this.alterar(c); }

  // Antecedência: lista (contas, vencimento da fatura) ou um valor só (fechamento da fatura)
  antecedenciaMultipla(c: ConfigAlerta): boolean { return Array.isArray(c.parametros.dias_antes); }
  temAntecedencia(c: ConfigAlerta, d: number): boolean {
    const v = c.parametros.dias_antes;
    return Array.isArray(v) ? v.includes(d) : v === d;
  }
  alternarAntecedencia(c: ConfigAlerta, d: number) {
    const v = c.parametros.dias_antes;
    if (Array.isArray(v)) c.parametros.dias_antes = v.includes(d) ? v.filter((x) => x !== d) : [...v, d].sort((a, b) => b - a);
    else c.parametros.dias_antes = d;
    this.alterar(c);
  }
  rotuloAntecedencia(d: number): string { return d === 0 ? 'No dia' : d === 1 ? '1 dia antes' : `${d} dias antes`; }

  alternarLista(c: ConfigAlerta, campo: 'percentuais' | 'dias_semana' | 'itens', v: number) {
    const atual = (c.parametros[campo] as number[]) ?? [];
    c.parametros[campo] = atual.includes(v) ? atual.filter((x) => x !== v) : [...atual, v].sort((a, b) => a - b);
    this.alterar(c);
  }
  temNaLista(c: ConfigAlerta, campo: 'percentuais' | 'dias_semana' | 'itens', v: number): boolean {
    return ((c.parametros[campo] as number[]) ?? []).includes(v);
  }

  // Destinatários: "todos" ou uma lista de pessoas
  recebe(c: ConfigAlerta, p: PessoaWhatsapp): boolean { return c.destinatarios === 'todos' || c.destinatarios.includes(p.id); }
  alternarDestinatario(c: ConfigAlerta, p: PessoaWhatsapp) {
    const todos = this.pessoasComTelefone.map((x) => x.id);
    const atual = c.destinatarios === 'todos' ? todos : c.destinatarios;
    const novo = atual.includes(p.id) ? atual.filter((x) => x !== p.id) : [...atual, p.id];
    c.destinatarios = novo.length === todos.length && todos.every((id) => novo.includes(id)) ? 'todos' : novo;
    this.alterar(c);
  }

  // Itens do alerta programado, agrupados por categoria
  get gruposItens(): { categoria: string; itens: ItemAlerta[] }[] {
    const busca = this.buscaItem.trim().toLowerCase();
    const grupos = new Map<string, ItemAlerta[]>();
    for (const i of this.dados?.itens ?? []) {
      if (busca && !`${i.descricao} ${i.categoria_nome}`.toLowerCase().includes(busca)) continue;
      if (!grupos.has(i.categoria_nome)) grupos.set(i.categoria_nome, []);
      grupos.get(i.categoria_nome)!.push(i);
    }
    return [...grupos].map(([categoria, itens]) => ({ categoria, itens }));
  }
  nomesItens(c: ConfigAlerta): string {
    const ids = c.parametros.itens ?? [];
    if (!ids.length) return 'Alimentação fora de casa (padrão)';
    const nomes = (this.dados?.itens ?? []).filter((i) => ids.includes(i.id)).map((i) => i.descricao);
    return nomes.length > 2 ? `${nomes.slice(0, 2).join(', ')} e mais ${nomes.length - 2}` : nomes.join(', ');
  }
  semMeta(c: ConfigAlerta): boolean {
    const ids = c.parametros.itens ?? [];
    return (this.dados?.itens ?? []).some((i) => ids.includes(i.id) && !i.meta);
  }

  // ── Simulador de conversa ──
  enviar() {
    const texto = this.textoChat.trim();
    if (!texto || this.enviando) return;
    const pessoa = this.dados?.pessoas.find((p) => p.id === this.pessoaChat);
    this.chat.push({ de: 'pessoa', texto, nome: pessoa?.nome.split(' ')[0] });
    this.textoChat = '';
    this.enviando = true;
    this.rolarChat();
    this.service.simular(texto, this.pessoaChat).subscribe({
      next: (r) => { this.chat.push({ de: 'app', texto: r.resposta }); this.enviando = false; this.rolarChat(); this.carregarAvisos(); },
      error: (e) => { this.chat.push({ de: 'app', texto: e?.error?.erro || 'Não foi possível processar a mensagem.' }); this.enviando = false; this.rolarChat(); },
    });
  }
  private rolarChat() {
    this.cdr.detectChanges();
    this.chatFim()?.nativeElement.scrollIntoView({ block: 'end' });
  }

  abrirTexto(tipo: string) {
    if (this.textoAberto === tipo) { this.textoAberto = null; return; }
    const t = this.textos[tipo];
    this.textoAberto = tipo; this.rascunho = t?.texto || t?.padrao || ''; this.msgTexto = ''; this.erroTexto = '';
  }
  inserirVariavel(campo: HTMLTextAreaElement, v: string) {
    const ini = campo.selectionStart ?? this.rascunho.length, fim = campo.selectionEnd ?? ini;
    this.rascunho = this.rascunho.slice(0, ini) + `{${v}}` + this.rascunho.slice(fim);
    setTimeout(() => { campo.focus(); campo.setSelectionRange(ini + v.length + 2, ini + v.length + 2); });
  }
  previaTexto(tipo: string): string {
    const t = this.textos[tipo];
    if (!t) return '';
    return (this.rascunho || t.padrao).replace(/\{(\w+)\}/g, (m, k) => t.valores_exemplo[k] ?? m);
  }
  salvarTexto(tipo: string, restaurar = false) {
    const t = this.textos[tipo];
    if (!t) return;
    // Igual ao padrão = sem personalização
    const texto = restaurar || this.rascunho.trim() === t.padrao ? '' : this.rascunho.trim();
    this.service.salvarTexto(t.tipo, texto).subscribe({
      next: (r) => {
        t.texto = r.texto; this.rascunho = r.texto || t.padrao; this.erroTexto = '';
        this.msgTexto = restaurar ? 'Texto padrão restaurado.' : 'Texto salvo para todos os clientes.';
        this.cdr.detectChanges();
      },
      error: (e) => { this.erroTexto = e?.error?.erro || 'Não foi possível salvar o texto.'; this.cdr.detectChanges(); },
    });
  }

  rotuloStatus(s: string): string { return STATUS_AVISO[s] ?? s; }
  dataHora(iso: string): string {
    const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}
