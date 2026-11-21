// Regras da integração WhatsApp (rotas /integracao/whatsapp), com o servidor real e um banco temporário.
// Sem ANTHROPIC_API_KEY: mensagens com valor ficam em suspenso pelas regras, sem IA.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Database = require('better-sqlite3');

const DADOS_KEY = 'a'.repeat(64);
process.env.DADOS_KEY = DADOS_KEY; // o cripto.js lê a chave ao carregar
const { cifrar, indice } = require('../cripto');
const { chaveTelefone } = require('../whatsapp');

const TOKEN = 'token-de-teste';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zevem-teste-'));
let servidor, base, db;

const portaLivre = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
  const porta = await portaLivre();
  servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(porta), DATA_DIR: dataDir, DADOS_KEY, JWT_SECRET: 'x'.repeat(64),
      WHATSAPP_INTEGRACAO_TOKEN: TOKEN, ANTHROPIC_API_KEY: '', MASTER_EMAILS: 'master@teste.com',
      WHATSAPP_LIMITE_HORA: '5', WHATSAPP_DIAS_TESTE: '7', WHATSAPP_EXIGE_ASSINATURA: '1',
      // Fuso bem diferente de Brasília: a data do lançamento tem que seguir Brasília mesmo assim
      TZ: 'Etc/GMT-14',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  servidor.stdout.on('data', (d) => { log += d; });
  servidor.stderr.on('data', (d) => { log += d; });
  base = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (i === 99) throw new Error(`Servidor não subiu:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  db = new Database(path.join(dataDir, 'apple-green.db'));
});

after(() => {
  db?.close();
  servidor?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function criarConta({ diasDesdeCadastro = 0, email } = {}) {
  const r = db.prepare(`INSERT INTO usuarios (nome, email, senha_hash, confirmado, criado_em) VALUES (?, ?, 'x', 1, datetime('now', ?))`)
    .run('Conta', email || `conta${++seq}@teste.com`, `-${diasDesdeCadastro} days`);
  return Number(r.lastInsertRowid);
}
function criarPessoa(usuarioId, telefone, { verificado = false, nome = 'Maria Silva' } = {}) {
  const r = db.prepare('INSERT INTO pessoas (usuario_id, nome, telefone, telefone_indice, telefone_verificado) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, nome, cifrar(telefone), indice(chaveTelefone(telefone)), verificado ? 1 : 0);
  return Number(r.lastInsertRowid);
}
let numero = 900000000;
const novoTelefone = () => `11${++numero}`;

async function mensagem(corpo) {
  const r = await fetch(`${base}/integracao/whatsapp/mensagens`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tipo: 'texto', ...corpo }),
  });
  return { status: r.status, corpo: await r.json() };
}
const hojeBrasilia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

test('número cadastrado sem confirmação já conversa (lança em suspenso com a data de Brasília)', async () => {
  const conta = criarConta();
  const tel = novoTelefone();
  criarPessoa(conta, tel);
  const r = await mensagem({ mensagem_id: 'm-cad-1', telefone: `55${tel}`, texto: 'padaria 12,50' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.acao, 'suspenso');
  const s = db.prepare('SELECT * FROM gastos_suspensos WHERE usuario_id = ?').get(conta);
  assert.equal(s.valor, 12.5);
  assert.equal(s.data, hojeBrasilia());
});

test('número desconhecido e número confirmado em outra conta', async () => {
  const r = await mensagem({ mensagem_id: 'm-desc', telefone: '5511900000000', texto: 'oi' });
  assert.equal(r.corpo.acao, 'numero_desconhecido');

  // Mesmo número sem confirmação em duas contas: ambíguo; confirmado em uma: ela vence
  const tel = novoTelefone();
  const a = criarConta(), b = criarConta();
  criarPessoa(a, tel); criarPessoa(b, tel);
  assert.equal((await mensagem({ mensagem_id: 'm-amb', telefone: tel, texto: 'uber 20' })).corpo.acao, 'numero_ambiguo');
  db.prepare('UPDATE pessoas SET telefone_verificado = 1 WHERE usuario_id = ?').run(b);
  assert.equal((await mensagem({ mensagem_id: 'm-amb2', telefone: tel, texto: 'uber 20' })).corpo.acao, 'suspenso');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gastos_suspensos WHERE usuario_id = ?').get(b).n, 1);
});

test('mesma mensagem_id: repetida não lança de novo; em processamento recebe 409', async () => {
  const conta = criarConta();
  const tel = novoTelefone();
  criarPessoa(conta, tel);
  const a = await mensagem({ mensagem_id: 'm-rep', telefone: tel, texto: 'mercado 80' });
  const b = await mensagem({ mensagem_id: 'm-rep', telefone: tel, texto: 'mercado 80' });
  assert.equal(b.corpo.repetida, true);
  assert.equal(b.corpo.resposta, a.corpo.resposta);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gastos_suspensos WHERE usuario_id = ?').get(conta).n, 1);

  // Outra chamada ainda processando a mesma mensagem
  db.prepare(`INSERT INTO whatsapp_mensagens (mensagem_id, telefone, acao) VALUES ('m-proc', '', 'processando')`).run();
  assert.equal((await mensagem({ mensagem_id: 'm-proc', telefone: tel, texto: 'mercado 80' })).status, 409);
  // Reserva antiga (processamento interrompido): processa de novo
  db.prepare(`INSERT INTO whatsapp_mensagens (mensagem_id, telefone, acao, criado_em) VALUES ('m-velha', '', 'processando', datetime('now', '-5 minutes'))`).run();
  const c = await mensagem({ mensagem_id: 'm-velha', telefone: tel, texto: 'feira 30' });
  assert.equal(c.status, 200);
  assert.equal(c.corpo.acao, 'suspenso');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_mensagens WHERE mensagem_id = 'm-velha'").get().n, 1);
});

test('sem assinatura e fora do teste: não processa; com assinatura, master ou em teste: processa', async () => {
  const tel = novoTelefone();
  const antiga = criarConta({ diasDesdeCadastro: 30 });
  criarPessoa(antiga, tel);
  const r = await mensagem({ mensagem_id: 'm-sa', telefone: tel, texto: 'cinema 40' });
  assert.equal(r.corpo.acao, 'sem_assinatura');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gastos_suspensos WHERE usuario_id = ?').get(antiga).n, 0);

  db.prepare(`INSERT INTO assinaturas (usuario_id, plano_id, status, inicio_ciclo, fim_ciclo, valor_ciclo) VALUES (?, 1, 'ativa', '2026-01-01', '2026-12-31', 100)`).run(antiga);
  assert.equal((await mensagem({ mensagem_id: 'm-sa2', telefone: tel, texto: 'cinema 40' })).corpo.acao, 'suspenso');

  const master = criarConta({ diasDesdeCadastro: 30, email: 'master@teste.com' });
  const telM = novoTelefone();
  criarPessoa(master, telM);
  assert.equal((await mensagem({ mensagem_id: 'm-sa3', telefone: telM, texto: 'cinema 40' })).corpo.acao, 'suspenso');
});

test('SAIR desliga os avisos, VOLTAR religa (e pede confirmação se o número não foi confirmado)', async () => {
  const conta = criarConta();
  const tel = novoTelefone();
  const p = criarPessoa(conta, tel, { verificado: true });
  const sair = await mensagem({ mensagem_id: 'm-sair', telefone: tel, texto: 'Sair' });
  assert.equal(sair.corpo.acao, 'avisos_desligados');
  assert.ok(db.prepare('SELECT whatsapp_optout_em FROM pessoas WHERE id = ?').get(p).whatsapp_optout_em);
  assert.equal((await mensagem({ mensagem_id: 'm-voltar', telefone: tel, texto: 'VOLTAR!' })).corpo.acao, 'avisos_ligados');
  assert.equal(db.prepare('SELECT whatsapp_optout_em FROM pessoas WHERE id = ?').get(p).whatsapp_optout_em, null);

  const tel2 = novoTelefone();
  criarPessoa(criarConta(), tel2);
  assert.equal((await mensagem({ mensagem_id: 'm-voltar2', telefone: tel2, texto: 'voltar' })).corpo.acao, 'avisos_sem_confirmacao');
});

test('limite de mensagens por número', async () => {
  const conta = criarConta();
  const tel = novoTelefone();
  criarPessoa(conta, tel);
  const acoes = [];
  for (let i = 0; i < 6; i++) acoes.push((await mensagem({ mensagem_id: `m-lim-${i}`, telefone: tel, texto: `cafe ${i + 1}` })).corpo.acao);
  assert.deepEqual(acoes, ['suspenso', 'suspenso', 'suspenso', 'suspenso', 'suspenso', 'limite']);
  // Repetição de mensagem já respondida não conta nem é barrada
  assert.equal((await mensagem({ mensagem_id: 'm-lim-0', telefone: tel, texto: 'cafe 1' })).corpo.repetida, true);
});
