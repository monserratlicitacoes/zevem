// ── Criptografia dos dados pessoais guardados no banco (CPF, e-mail e telefone das pessoas) ──
//
// AES-256-GCM com a chave DADOS_KEY (64 caracteres hex: openssl rand -hex 32). Quem copiar só o arquivo
// do banco não lê esses campos. Valor gravado: "enc:v1:<base64 de iv(12) + tag(16) + texto cifrado>".
// Valores antigos, ainda em texto puro, continuam sendo lidos (e são cifrados na subida do servidor).
// ATENÇÃO: perder a DADOS_KEY é perder esses campos. Guarde-a junto dos backups, fora do banco.

const crypto = require('crypto');

const PREFIXO = 'enc:v1:';
const CHAVE_DEV = 'zevem-dados-somente-desenvolvimento';

const DADOS_KEY = process.env.DADOS_KEY || '';
const chaveValida = /^[0-9a-f]{64}$/i.test(DADOS_KEY);
const mestra = chaveValida ? Buffer.from(DADOS_KEY, 'hex') : crypto.createHash('sha256').update(CHAVE_DEV).digest();
// Subchaves separadas para cifrar e para o índice de busca do telefone
const chaveCifra = Buffer.from(crypto.hkdfSync('sha256', mestra, Buffer.alloc(0), 'zevem-cifra', 32));
const chaveIndice = Buffer.from(crypto.hkdfSync('sha256', mestra, Buffer.alloc(0), 'zevem-indice', 32));

function cifrar(texto) {
  const t = String(texto ?? '');
  if (!t || t.startsWith(PREFIXO)) return t;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chaveCifra, iv);
  const corpo = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return PREFIXO + Buffer.concat([iv, c.getAuthTag(), corpo]).toString('base64');
}

function decifrar(valor) {
  const v = String(valor ?? '');
  if (!v.startsWith(PREFIXO)) return v;
  try {
    const b = Buffer.from(v.slice(PREFIXO.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', chaveCifra, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    console.error('[cripto] não foi possível decifrar um campo (DADOS_KEY trocada?)');
    return '';
  }
}

// Índice de busca: HMAC da chave do telefone (acha a pessoa pelo número sem guardar o número aberto)
const indice = (t) => (t ? crypto.createHmac('sha256', chaveIndice).update(String(t)).digest('hex') : null);

module.exports = { cifrar, decifrar, indice, chaveValida };
