// Versão noturna gerada a partir das folhas de estilo do app.
//
// Em vez de reescrever à mão cada cor clara de cada página, as regras de cor são relidas e recebem
// uma versão escura, aplicada só com <html class="tema-noturno">:
//   • fundos, bordas e sombras claros e pouco saturados (brancos, off-white, cinzas esverdeados,
//     tons claros de lima/rosa/âmbar) viram verdes quase pretos, mantendo o matiz;
//   • textos e traços escuros viram claros;
//   • cores vivas (lima, rosa, verdes de status) e transparências leves ficam como estão.
// As regras geradas repetem o seletor original com ":root.tema-noturno" na frente: ganham da regra
// clara de mesmo seletor, mas perdem para estilos inline ([style.x]="..." dos gráficos).
// O Dashboard tem uma versão noturna própria, feita à mão (.page.noturno), e fica de fora.

type Rgba = [number, number, number, number];

const PREFIXO = ':root.tema-noturno';

// ── Conversão sRGB ⇄ OKLCH ──
function linear(c: number): number { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function gamma(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
function paraOklch([r, g, b]: Rgba): [number, number, number] {
  const lr = linear(r), lg = linear(g), lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}
function deOklch(L: number, C: number, H: number, a: number): Rgba {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a,
  ];
}
function css([r, g, b, a]: Rgba): string { return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`; }

// Matiz e croma dos neutros no escuro: o verde da marca (#071a11 / #0b2419 do Dashboard)
const MATIZ_MARCA = 160;
const CROMA_NEUTRO = 0.025;

type Papel = 'fundo' | 'borda' | 'texto';

function converter(cor: Rgba, papel: Papel): Rgba | null {
  const [L, C, H] = paraOklch(cor);
  const a = cor[3];
  if (a < 0.3) return null; // véus e sombras leves: iguais
  const neutro = C < 0.02;
  const matiz = neutro ? MATIZ_MARCA : H;
  if (papel === 'texto') {
    if (L >= 0.62 || C >= 0.13) return null; // já claro ou cor viva
    return deOklch(Math.min(0.96, 0.97 - (L - 0.25) * 0.9), neutro ? CROMA_NEUTRO * 0.6 : Math.min(C, 0.09), matiz, a);
  }
  if (L < 0.78 || C >= 0.1) return null; // escuro ou cor viva (lima, rosa)
  const croma = neutro ? CROMA_NEUTRO : Math.min(C * 0.7, 0.05);
  if (papel === 'borda') return deOklch(0.33 + (0.995 - L) * 0.5, croma, matiz, a);
  // Fundos: o branco dos cartões fica um pouco acima do fundo da página (off-white)
  const Ln = L >= 0.995 ? 0.255 : 0.2 + (0.995 - L) * 0.55;
  return deOklch(Ln, croma, matiz, a);
}

// ── Leitura de cores dentro de um valor CSS ──
const NOMES: Record<string, Rgba> = { white: [255, 255, 255, 1], black: [0, 0, 0, 1] };
const RE_COR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi;

function lerCor(t: string): Rgba | null {
  const s = t.toLowerCase();
  if (NOMES[s]) return NOMES[s];
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const p = s.slice(s.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (p.length < 3 || p.some(isNaN)) return null;
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function converterValor(valor: string, papel: Papel): string | null {
  let mudou = false;
  const novo = valor.replace(RE_COR, (t) => {
    const c = lerCor(t);
    const n = c && converter(c, papel);
    if (!n) return t;
    mudou = true;
    return css(n);
  });
  return mudou ? novo : null;
}

const PAPEIS: Record<string, Papel> = {
  'background-color': 'fundo', 'background-image': 'fundo', 'box-shadow': 'fundo',
  'border-top-color': 'borda', 'border-right-color': 'borda', 'border-bottom-color': 'borda',
  'border-left-color': 'borda', 'outline-color': 'borda', 'column-rule-color': 'borda',
  color: 'texto', fill: 'texto', stroke: 'texto', 'text-decoration-color': 'texto', 'caret-color': 'texto',
};
const ATALHOS_COR = ['background', 'border', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'outline'];
const VIVA = (v: string) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v);

// Separa "a, b:is(c, d)" nas vírgulas de fora dos parênteses
function partesSeletor(sel: string): string[] {
  const out: string[] = [];
  let nivel = 0, ini = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(') nivel++;
    else if (c === ')') nivel--;
    else if (c === ',' && nivel === 0) { out.push(sel.slice(ini, i)); ini = i + 1; }
  }
  out.push(sel.slice(ini));
  return out.map((s) => s.trim()).filter(Boolean);
}
function prefixar(sel: string): string {
  return partesSeletor(sel)
    .map((s) => {
      if (/^(html|:root)\b/.test(s)) return s.replace(/^(html|:root)/, `${PREFIXO}${PREFIXO.slice(5)}`);
      return `${PREFIXO} ${s}`;
    })
    .join(', ');
}

function regraEscura(regra: CSSStyleRule, ignorar: RegExp | null): string {
  const sel = regra.selectorText;
  if (!sel || (ignorar && ignorar.test(sel)) || sel.includes('tema-noturno') || sel.includes('.noturno')) return '';
  const st = regra.style;
  const decl: string[] = [];
  // Cor de destaque no próprio fundo da regra (ex.: botão lima): o texto escuro dele fica como está
  const fundo = st.getPropertyValue('background-color') || st.getPropertyValue('background-image');
  const fundoVivo = !!fundo && VIVA(fundo) && converterValor(fundo, 'fundo') === null && !/rgba?\([^)]*,\s*0(\.[0-2]\d*)?\)/.test(fundo);
  for (let i = 0; i < st.length; i++) {
    const prop = st[i];
    const papel = PAPEIS[prop];
    if (!papel) continue;
    let v = st.getPropertyValue(prop);
    if (!v) continue;
    // O navegador às vezes devolve "initial" dentro da lista de imagens, o que invalida a declaração
    if (prop === 'background-image') v = v.replace(/\binitial\b/g, 'none');
    const n = papel === 'texto' && fundoVivo ? null : converterValor(v, papel);
    // As cores que não mudam também são repetidas: assim a ordem entre as regras continua a mesma
    // (ex.: o lima do botão "Resumo" segue valendo sobre o fundo genérico dos botões, que escureceu)
    decl.push(`${prop}: ${n ?? v}${st.getPropertyPriority(prop) ? ' !important' : ''};`);
  }
  // Atalhos com variável (ex.: "background: var(--ag-verde-lima)"): o navegador não expõe a cor nas
  // propriedades longas, então o atalho é repetido como está
  for (const atalho of ATALHOS_COR) {
    const v = st.getPropertyValue(atalho);
    if (v && v.includes('var(')) decl.push(`${atalho}: ${v}${st.getPropertyPriority(atalho) ? ' !important' : ''};`);
  }
  return decl.length ? `${prefixar(sel)} { ${decl.join(' ')} }\n` : '';
}

function percorrer(regras: CSSRuleList, ignorar: RegExp | null): string {
  let out = '';
  for (const r of Array.from(regras)) {
    if (r instanceof CSSStyleRule) {
      out += regraEscura(r, ignorar);
      if (r.cssRules?.length) out += percorrer(r.cssRules, ignorar); // CSS aninhado
    } else if (r instanceof CSSMediaRule) {
      const dentro = percorrer(r.cssRules, ignorar);
      if (dentro) out += `@media ${r.conditionText} {\n${dentro}}\n`;
    } else if (r instanceof CSSSupportsRule) {
      const dentro = percorrer(r.cssRules, ignorar);
      if (dentro) out += `@supports ${r.conditionText} {\n${dentro}}\n`;
    }
  }
  return out;
}

// Gera o CSS escuro de uma folha. `ignorar`: seletores que ficam de fora (o Dashboard).
export function cssNoturno(folha: CSSStyleSheet, ignorar: RegExp | null): string {
  let regras: CSSRuleList;
  try { regras = folha.cssRules; } catch { return ''; } // folha de outro domínio (Google Fonts)
  return percorrer(regras, ignorar);
}
