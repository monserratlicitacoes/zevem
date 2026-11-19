// ── Checkout da página de venda (/checkout): paga e entra na hora ──
//
// Etapas (front: src/app/pages/checkout):
//   1. Quem é você   POST /checkout/iniciar          nome, e-mail, WhatsApp, CPF → id do checkout
//   2. Seu plano     GET  /checkout/plano            plano anual em 12x (ou à vista no Pix)
//   3. Pagamento     POST /checkout/:id/cartao       12x no cartão, aprovado na hora
//                    POST /checkout/:id/pix          QR Code; GET /checkout/:id/status acompanha até o pagamento
//   4. Ativação      POST /checkout/:id/ativar       cria a senha e devolve a sessão (o cliente entra sem redirecionar)
//
// Com o pagamento confirmado, a conta é criada já confirmada (com uma senha aleatória) e a assinatura nasce
// paga (pagamentos.registrarAssinaturaPaga). Se o cliente fechar a página antes da etapa 4, o e-mail de
// boas-vindas leva para "criar senha" (/redefinir-senha).
// O id do checkout (48 caracteres aleatórios) é a credencial do comprador durante a compra: vale até a ativação.
// Os dados do cartão só passam por aqui a caminho do Asaas: não são gravados nem vão para o log.

const asaas = require('./asaas');

const PLANO_CHECKOUT = { nome: 'Zevem Anual', valor_anual: 334.8, parcelas: 12 };
const VALIDADE_HORAS = 48;
const DIAS_AVISO_RENOVACAO = 7;

module.exports = function registrarCheckout(ctx) {
  const {
    app, db, pagamentos, gerarToken, bcrypt, crypto, cifrar, decifrar, indice, chaveTelefone, criarPessoaTitular, cpfValido, telefoneNormalizado,
    normalizarEmail, emailValido, erroSenha, enviarEmail, escaparHtml, FRONTEND_URL, limitador, agoraBrasilia, master,
  } = ctx;

  db.exec(`
    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT NOT NULL,
      cpf TEXT NOT NULL,                        -- cifrado
      telefone TEXT NOT NULL,                   -- cifrado
      status TEXT NOT NULL DEFAULT 'iniciado',  -- iniciado | processando | aguardando_pix | pago | ativado
      forma TEXT,                               -- cartao | pix
      asaas_cliente_id TEXT,
      asaas_pagamento_id TEXT,
      pix_copia_e_cola TEXT,
      pix_qr TEXT,
      usuario_id INTEGER,
      ip TEXT,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      pago_em DATETIME,
      ativado_em DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_checkouts_pagamento ON checkouts(asaas_pagamento_id);
    -- Cupons de desconto (Master › Cupons): valem só para o 1º ano; a renovação volta ao preço do plano
    CREATE TABLE IF NOT EXISTS cupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,              -- maiúsculas, sem espaços
      tipo TEXT NOT NULL DEFAULT 'percentual',  -- percentual | valor
      valor REAL NOT NULL,                      -- % (ex.: 20) ou R$ de desconto no ano
      valido_ate TEXT,                          -- AAAA-MM-DD (inclusive); vazio = sem prazo
      limite_usos INTEGER,                      -- vazio = sem limite
      descricao TEXT NOT NULL DEFAULT '',       -- anotação interna (ex.: parceria, campanha)
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try { db.prepare('ALTER TABLE checkouts ADD COLUMN cupom_id INTEGER').run(); } catch {}

  // Plano vendido no checkout: o master pode mudar o preço em Master › Planos (mesmo nome)
  function plano() {
    let p = db.prepare('SELECT * FROM planos WHERE nome = ? AND ativo = 1 ORDER BY id LIMIT 1').get(PLANO_CHECKOUT.nome);
    if (!p) {
      const r = db.prepare('INSERT INTO planos (nome, valor_anual, parcelas) VALUES (?, ?, ?)').run(PLANO_CHECKOUT.nome, PLANO_CHECKOUT.valor_anual, PLANO_CHECKOUT.parcelas);
      p = db.prepare('SELECT * FROM planos WHERE id = ?').get(r.lastInsertRowid);
    }
    return p;
  }
  plano();

  const limCheckout = limitador(15 * 60 * 1000, 40);
  const limCartao = limitador(60 * 60 * 1000, 8);      // tentativas de cartão por IP (barra teste de cartões)
  const limStatus = limitador(15 * 60 * 1000, 600);    // acompanhamento do Pix

  const emailTemConta = (email) => !!db.prepare('SELECT 1 FROM usuarios WHERE lower(trim(email)) = ?').get(email);
  const valido = (ck) => ck && Date.now() - new Date(`${ck.criado_em.replace(' ', 'T')}Z`).getTime() < VALIDADE_HORAS * 3600 * 1000;
  const buscar = (id) => db.prepare('SELECT * FROM checkouts WHERE id = ?').get(String(id || ''));
  const erro = (res, status, mensagem, extra = {}) => res.status(status).json({ erro: mensagem, ...extra });
  const resumoPlano = (p) => {
    const parcela = Math.round((p.valor_anual / p.parcelas) * 100) / 100;
    return { nome: p.nome, valor_anual: p.valor_anual, parcelas: p.parcelas, valor_parcela: parcela, disponivel: asaas.configurado() };
  };

  // ── Cupons ──
  // O Asaas exige parcela de no mínimo R$ 5: o total com desconto nunca fica abaixo de parcelas × R$ 5.
  const PARCELA_MINIMA = 5;
  const centavos = (v) => Math.round(v * 100) / 100;
  const normalizarCodigo = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
  const usosDoCupom = (id) => db.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE cupom_id = ? AND status IN ('pago', 'ativado')").get(id).n;
  function valorComCupom(p, cupom) {
    if (!cupom) return p.valor_anual;
    const desconto = cupom.tipo === 'valor' ? cupom.valor : (p.valor_anual * cupom.valor) / 100;
    return centavos(Math.max(p.valor_anual - desconto, p.parcelas * PARCELA_MINIMA));
  }
  // Motivo de o cupom não valer agora (ou null se vale)
  function problemaCupom(cupom) {
    if (!cupom || !cupom.ativo) return 'Cupom inválido.';
    if (cupom.valido_ate && cupom.valido_ate < agoraBrasilia().hoje) return 'Este cupom expirou.';
    if (cupom.limite_usos && usosDoCupom(cupom.id) >= cupom.limite_usos) return 'Este cupom já foi usado o número máximo de vezes.';
    return null;
  }
  // Preço desta compra: plano + cupom (se ainda valer)
  function precoDo(ck) {
    const p = plano();
    const cupom = ck.cupom_id ? db.prepare('SELECT * FROM cupons WHERE id = ?').get(ck.cupom_id) : null;
    const vale = cupom && !problemaCupom(cupom);
    const total = valorComCupom(p, vale ? cupom : null);
    return {
      plano: p, total, parcela: centavos(total / p.parcelas), cupom: vale ? cupom : null,
      cupomCaiu: !!cupom && !vale ? problemaCupom(cupom) : null,
    };
  }
  const resumoPreco = (pr) => ({
    valor_anual: pr.total, valor_parcela: pr.parcela, parcelas: pr.plano.parcelas, valor_cheio: pr.plano.valor_anual,
    cupom: pr.cupom ? { codigo: pr.cupom.codigo, tipo: pr.cupom.tipo, valor: pr.cupom.valor, desconto: centavos(pr.plano.valor_anual - pr.total) } : null,
  });

  app.get('/checkout/plano', limCheckout, (req, res) => res.json(resumoPlano(plano())));

  // ── 1. Quem é você ──
  app.post('/checkout/iniciar', limCheckout, (req, res) => {
    if (req.body.site) return res.status(201).json({ id: crypto.randomBytes(24).toString('hex') }); // campo-armadilha: robô
    const nome = String(req.body.nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const email = normalizarEmail(req.body.email);
    const cpf = String(req.body.cpf ?? '').replace(/\D/g, '');
    const telefone = telefoneNormalizado(req.body.telefone);
    if (nome.split(' ').length < 2) return erro(res, 400, 'Informe o seu nome completo.');
    if (!emailValido(email)) return erro(res, 400, 'Informe um e-mail válido.');
    if (!telefone) return erro(res, 400, 'Informe o WhatsApp com DDD.');
    if (!cpfValido(cpf)) return erro(res, 400, 'CPF inválido.');
    if (emailTemConta(email)) return erro(res, 409, 'Este e-mail já tem conta no Zevem. Entre com a sua senha.', { conta: true });

    // Voltou da etapa 2 ou 3 para corrigir: atualiza o mesmo checkout enquanto não houver pagamento
    const atual = buscar(req.body.id);
    if (atual && valido(atual) && ['iniciado', 'aguardando_pix'].includes(atual.status)) {
      const mudouComprador = atual.email !== email || decifrar(atual.cpf) !== cpf;
      db.prepare(`UPDATE checkouts SET nome = ?, email = ?, cpf = ?, telefone = ?, ip = ?,
        asaas_cliente_id = CASE WHEN ? THEN NULL ELSE asaas_cliente_id END WHERE id = ?`)
        .run(nome, email, cifrar(cpf), cifrar(telefone), req.ip, mudouComprador ? 1 : 0, atual.id);
      return res.json({ id: atual.id });
    }
    const id = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO checkouts (id, nome, email, cpf, telefone, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, nome, email, cifrar(cpf), cifrar(telefone), req.ip);
    res.status(201).json({ id });
  });

  // Cliente no Asaas (um por checkout; reaproveitado se o cliente trocar cartão ↔ Pix)
  async function clienteAsaas(ck) {
    if (ck.asaas_cliente_id) return ck.asaas_cliente_id;
    const id = await asaas.criarCliente({
      nome: ck.nome, email: ck.email, cpf: decifrar(ck.cpf), telefone: decifrar(ck.telefone), referencia: `checkout:${ck.id.slice(0, 12)}`,
    });
    db.prepare('UPDATE checkouts SET asaas_cliente_id = ? WHERE id = ?').run(id, ck.id);
    return id;
  }

  // Pagamento confirmado: cria a conta (ou usa a que surgiu com o mesmo e-mail) e a assinatura paga
  function confirmarPagamento(ckId, { forma, parcelamento_id, cartao_token, cobrancas }) {
    const resultado = db.transaction(() => {
      const ck = buscar(ckId);
      if (!ck || ['pago', 'ativado'].includes(ck.status)) return null;
      const pr = precoDo(ck);
      const p = pr.plano;
      const pago = centavos((cobrancas || []).reduce((t, c) => t + Number(c.valor || 0), 0)) || pr.total;
      let usuario = db.prepare('SELECT id FROM usuarios WHERE lower(trim(email)) = ?').get(ck.email);
      const contaNova = !usuario;
      if (contaNova) {
        const senhaAleatoria = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
        const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, confirmado) VALUES (?, ?, ?, 1)').run(ck.nome, ck.email, senhaAleatoria);
        usuario = { id: r.lastInsertRowid };
        criarPessoaTitular(usuario.id);
        const tel = decifrar(ck.telefone);
        db.prepare('UPDATE pessoas SET cpf = ?, telefone = ?, telefone_indice = ? WHERE usuario_id = ?')
          .run(ck.cpf, ck.telefone, indice(chaveTelefone(tel)), usuario.id);
      }
      pagamentos.registrarAssinaturaPaga({
        usuarioId: usuario.id, plano: p, inicio: agoraBrasilia().hoje, provedor: 'asaas', cliente_id: ck.asaas_cliente_id,
        parcelamento_id, cartao_token, ip: ck.ip, cobrancas, valor: pago, cupom_id: ck.cupom_id,
      });
      // Conta que já existia (raro: criada durante a compra) não troca de senha pelo checkout
      db.prepare("UPDATE checkouts SET status = ?, forma = ?, usuario_id = ?, pago_em = CURRENT_TIMESTAMP WHERE id = ?")
        .run(contaNova ? 'pago' : 'ativado', forma, usuario.id, ck.id);
      return { ck, contaNova };
    })();
    if (resultado) emailBoasVindas(resultado.ck, resultado.contaNova);
    return resultado;
  }

  function emailBoasVindas(ck, contaNova) {
    const primeiro = escaparHtml(ck.nome.split(' ')[0]);
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
        <div style="background:#181818;border-radius:14px;padding:32px;text-align:center;color:#f4f5f0;">
          <h2 style="margin:0 0 8px;">Bem-vindo ao Zevem, ${primeiro}!</h2>
          <p style="color:#a3a8a0;font-size:14px;line-height:1.6;margin:0 0 24px;">
            Seu pagamento foi confirmado e a sua conta está pronta.<br>
            ${contaNova ? 'Se você ainda não criou a sua senha, crie pelo botão abaixo.' : 'Entre com o seu e-mail e a sua senha de sempre.'}</p>
          <a href="${FRONTEND_URL}/${contaNova ? 'redefinir-senha' : 'login'}" style="display:inline-block;background:#b1f70d;color:#181818;
            padding:14px 32px;border-radius:10px;font-weight:800;text-decoration:none;font-size:14px;">${contaNova ? 'Criar minha senha' : 'Entrar no Zevem'}</a>
          <p style="color:#a3a8a0;font-size:12px;line-height:1.6;margin:24px 0 0;">Você tem 30 dias de garantia: se não for para você, responda este e-mail e eu devolvo o valor.</p>
        </div>
      </div>`;
    enviarEmail(ck.email, 'Seu acesso ao Zevem está liberado', html).catch((e) => console.error('[checkout] boas-vindas:', e.message));
  }

  // ── 2. Cupom de desconto (na etapa do plano) ──
  // Aplica ou tira (código vazio). Se já houver um Pix gerado, ele é apagado: o valor mudou.
  app.post('/checkout/:id/cupom', limCheckout, async (req, res) => {
    const ck = buscar(req.params.id);
    if (!valido(ck)) return erro(res, 404, 'Este checkout expirou. Recomece a assinatura.');
    if (!['iniciado', 'aguardando_pix'].includes(ck.status)) return erro(res, 409, 'O pagamento já foi feito.');
    const codigo = normalizarCodigo(req.body.codigo);
    let cupomId = null;
    if (codigo) {
      const cupom = db.prepare('SELECT * FROM cupons WHERE codigo = ?').get(codigo);
      const problema = problemaCupom(cupom);
      if (problema) return erro(res, 400, problema);
      cupomId = cupom.id;
    }
    if (ck.status === 'aguardando_pix' && ck.asaas_pagamento_id && cupomId !== ck.cupom_id) {
      const pix = await asaas.consultarPagamento(ck.asaas_pagamento_id).catch(() => null);
      if (pix && asaas.PAGO.includes(pix.status)) return erro(res, 409, 'O Pix já foi pago.');
      await asaas.cancelarCobranca(ck.asaas_pagamento_id).catch(() => {});
      db.prepare("UPDATE checkouts SET status = 'iniciado', asaas_pagamento_id = NULL, pix_qr = NULL, pix_copia_e_cola = NULL WHERE id = ?").run(ck.id);
    }
    db.prepare('UPDATE checkouts SET cupom_id = ? WHERE id = ?').run(cupomId, ck.id);
    res.json(resumoPreco(precoDo(buscar(ck.id))));
  });
  app.get('/checkout/:id/preco', limStatus, (req, res) => {
    const ck = buscar(req.params.id);
    if (!ck) return erro(res, 404, 'Checkout não encontrado.');
    res.json(resumoPreco(precoDo(ck)));
  });

  // ── Master › Cupons ──
  function lerCupom(b, atual = {}) {
    const codigo = normalizarCodigo(b.codigo ?? atual.codigo);
    const tipo = (b.tipo ?? atual.tipo) === 'valor' ? 'valor' : 'percentual';
    const valor = centavos(Number(b.valor ?? atual.valor));
    const validoAte = (b.valido_ate ?? atual.valido_ate) || null;
    const limite = b.limite_usos === undefined ? atual.limite_usos ?? null : (parseInt(b.limite_usos, 10) || null);
    const descricao = String(b.descricao ?? atual.descricao ?? '').trim().slice(0, 200);
    const ativo = b.ativo === undefined ? (atual.ativo ?? 1) : (b.ativo ? 1 : 0);
    if (!/^[A-Z0-9_-]{3,30}$/.test(codigo)) return { erro: 'O código precisa ter de 3 a 30 letras, números, - ou _ (sem espaços).' };
    if (!(valor > 0)) return { erro: 'Informe o desconto.' };
    if (tipo === 'percentual' && valor >= 100) return { erro: 'O desconto em % precisa ser menor que 100.' };
    if (validoAte && !/^\d{4}-\d{2}-\d{2}$/.test(validoAte)) return { erro: 'Data de validade inválida.' };
    if (limite !== null && limite < 1) return { erro: 'O limite de usos precisa ser 1 ou mais (ou vazio, sem limite).' };
    return { codigo, tipo, valor, valido_ate: validoAte, limite_usos: limite, descricao, ativo };
  }
  function listarCupons() {
    const p = plano();
    return db.prepare('SELECT * FROM cupons ORDER BY ativo DESC, id DESC').all().map((c) => {
      const usos = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(a.valor_ciclo), 0) AS receita FROM checkouts ck
        LEFT JOIN assinaturas a ON a.usuario_id = ck.usuario_id AND a.cupom_id = ck.cupom_id
        WHERE ck.cupom_id = ? AND ck.status IN ('pago', 'ativado')`).get(c.id);
      const total = valorComCupom(p, c);
      return {
        ...c, ativo: !!c.ativo, usos: usos.n, receita: centavos(usos.receita),
        preco_final: total, parcela_final: centavos(total / p.parcelas), situacao: problemaCupom(c) ? (c.ativo ? 'esgotado ou vencido' : 'desativado') : 'valendo',
      };
    });
  }
  app.get('/admin/cupons', master(), (req, res) => res.json({ cupons: listarCupons(), plano: resumoPlano(plano()) }));
  app.post('/admin/cupons', master(), (req, res) => {
    const c = lerCupom(req.body || {});
    if (c.erro) return erro(res, 400, c.erro);
    if (db.prepare('SELECT 1 FROM cupons WHERE codigo = ?').get(c.codigo)) return erro(res, 409, 'Já existe um cupom com esse código.');
    db.prepare('INSERT INTO cupons (codigo, tipo, valor, valido_ate, limite_usos, descricao, ativo) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.codigo, c.tipo, c.valor, c.valido_ate, c.limite_usos, c.descricao, c.ativo);
    res.status(201).json({ ok: true });
  });
  app.put('/admin/cupons/:id', master(), (req, res) => {
    const atual = db.prepare('SELECT * FROM cupons WHERE id = ?').get(req.params.id);
    if (!atual) return erro(res, 404, 'Cupom não encontrado.');
    const c = lerCupom(req.body || {}, atual);
    if (c.erro) return erro(res, 400, c.erro);
    if (db.prepare('SELECT 1 FROM cupons WHERE codigo = ? AND id <> ?').get(c.codigo, atual.id)) return erro(res, 409, 'Já existe um cupom com esse código.');
    db.prepare('UPDATE cupons SET codigo = ?, tipo = ?, valor = ?, valido_ate = ?, limite_usos = ?, descricao = ?, ativo = ? WHERE id = ?')
      .run(c.codigo, c.tipo, c.valor, c.valido_ate, c.limite_usos, c.descricao, c.ativo, atual.id);
    res.json({ ok: true });
  });
  // Excluir só cupom nunca usado; usado, desativa (o histórico das vendas guarda o cupom)
  app.delete('/admin/cupons/:id', master(), (req, res) => {
    const c = db.prepare('SELECT * FROM cupons WHERE id = ?').get(req.params.id);
    if (!c) return erro(res, 404, 'Cupom não encontrado.');
    if (usosDoCupom(c.id)) return erro(res, 409, 'Este cupom já foi usado em vendas. Desative em vez de excluir.');
    db.prepare('UPDATE checkouts SET cupom_id = NULL WHERE cupom_id = ?').run(c.id);
    db.prepare('DELETE FROM cupons WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  // ── 3a. Cartão: 12x, aprovado na hora ──
  app.post('/checkout/:id/cartao', limCartao, async (req, res) => {
    const ck = buscar(req.params.id);
    if (!valido(ck)) return erro(res, 404, 'Este checkout expirou. Recomece a assinatura.');
    if (['pago', 'ativado'].includes(ck.status)) return res.json({ status: ck.status });
    if (!asaas.configurado()) return erro(res, 503, 'O pagamento ainda não está disponível. Tente de novo mais tarde.');

    const c = req.body.cartao || {};
    const t = req.body.titular || {};
    const numero = String(c.numero ?? '').replace(/\D/g, '');
    const nomeCartao = String(c.nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const mes = String(c.mes ?? '').replace(/\D/g, '').padStart(2, '0');
    let ano = String(c.ano ?? '').replace(/\D/g, '');
    if (ano.length === 2) ano = `20${ano}`;
    const cvc = String(c.cvc ?? '').replace(/\D/g, '');
    const cpfTitular = String(t.cpf ?? '').replace(/\D/g, '');
    const cep = String(t.cep ?? '').replace(/\D/g, '');
    const numeroEndereco = String(t.numero ?? '').trim().slice(0, 10);
    if (numero.length < 13 || numero.length > 19) return erro(res, 400, 'Confira o número do cartão.');
    if (!nomeCartao) return erro(res, 400, 'Informe o nome impresso no cartão.');
    if (!(Number(mes) >= 1 && Number(mes) <= 12) || ano.length !== 4) return erro(res, 400, 'Confira a validade do cartão.');
    if (cvc.length < 3 || cvc.length > 4) return erro(res, 400, 'Confira o código de segurança (CVV).');
    if (!cpfValido(cpfTitular)) return erro(res, 400, 'CPF do titular do cartão inválido.');
    if (cep.length !== 8) return erro(res, 400, 'Informe o CEP do titular do cartão.');
    if (!numeroEndereco) return erro(res, 400, 'Informe o número do endereço do titular.');

    // Um pagamento por vez (clique duplo, duas abas)
    const trava = db.prepare("UPDATE checkouts SET status = 'processando' WHERE id = ? AND status IN ('iniciado', 'aguardando_pix')").run(ck.id);
    if (!trava.changes) return erro(res, 409, 'Seu pagamento já está sendo processado. Aguarde um instante.');
    const voltar = () => db.prepare("UPDATE checkouts SET status = ? WHERE id = ? AND status = 'processando'").run(ck.status, ck.id);

    try {
      // Trocou o Pix pelo cartão: apaga o Pix em aberto para não pagar duas vezes
      if (ck.status === 'aguardando_pix' && ck.asaas_pagamento_id) {
        const pix = await asaas.consultarPagamento(ck.asaas_pagamento_id).catch(() => null);
        if (pix && asaas.PAGO.includes(pix.status)) {
          voltar();
          await verificarPix(buscar(ck.id));
          return res.json({ status: buscar(ck.id).status });
        }
        await asaas.cancelarCobranca(ck.asaas_pagamento_id).catch(() => {});
        db.prepare("UPDATE checkouts SET asaas_pagamento_id = NULL, pix_qr = NULL, pix_copia_e_cola = NULL WHERE id = ?").run(ck.id);
      }
      const pr = precoDo(buscar(ck.id));
      if (pr.cupomCaiu) {
        db.prepare('UPDATE checkouts SET cupom_id = NULL WHERE id = ?').run(ck.id);
        voltar();
        return erro(res, 409, `${pr.cupomCaiu} O valor voltou para o preço normal. Confira e tente de novo.`, { cupom_caiu: true });
      }
      const cliente = await clienteAsaas(buscar(ck.id));
      const p = pr.plano;
      const r = await asaas.cobrarCartaoParcelado({
        cliente, total: pr.total, parcelas: p.parcelas, descricao: `${p.nome} — 1º ano${pr.cupom ? ` (cupom ${pr.cupom.codigo})` : ''}`, referencia: `checkout:${ck.id.slice(0, 12)}`,
        cartao: { numero, nome: nomeCartao, mes, ano, cvc },
        titular: { nome: nomeCartao, email: ck.email, cpf: cpfTitular, cep, numero: numeroEndereco, telefone: decifrar(ck.telefone) },
        ip: req.ip,
      });
      db.prepare('UPDATE checkouts SET asaas_pagamento_id = ? WHERE id = ?').run(r.pagamento_id, ck.id);
      const hoje = agoraBrasilia().hoje;
      confirmarPagamento(ck.id, {
        forma: 'cartao', parcelamento_id: r.parcelamento_id, cartao_token: r.cartao_token,
        cobrancas: r.parcelas.map((x) => ({ ...x, status: 'paga', pago_em: hoje, forma: 'cartao' })),
      });
      res.json({ status: buscar(ck.id).status });
    } catch (e) {
      voltar();
      if (e instanceof asaas.ErroAsaas) return erro(res, e.status >= 500 ? 502 : 402, e.message);
      console.error('[checkout] cartão:', e.message);
      erro(res, 500, 'Não foi possível concluir o pagamento. Tente de novo.');
    }
  });

  // ── 3b. Pix à vista ──
  app.post('/checkout/:id/pix', limCheckout, async (req, res) => {
    const ck = buscar(req.params.id);
    if (!valido(ck)) return erro(res, 404, 'Este checkout expirou. Recomece a assinatura.');
    if (['pago', 'ativado'].includes(ck.status)) return res.json({ status: ck.status });
    if (ck.status === 'aguardando_pix' && ck.pix_copia_e_cola) {
      return res.json({ status: ck.status, qr_imagem: ck.pix_qr, copia_e_cola: ck.pix_copia_e_cola });
    }
    if (!asaas.configurado()) return erro(res, 503, 'O pagamento ainda não está disponível. Tente de novo mais tarde.');
    const trava = db.prepare("UPDATE checkouts SET status = 'processando' WHERE id = ? AND status = 'iniciado'").run(ck.id);
    if (!trava.changes) return erro(res, 409, 'Seu pagamento já está sendo processado. Aguarde um instante.');
    try {
      const cliente = await clienteAsaas(ck);
      const pr = precoDo(ck);
      if (pr.cupomCaiu) {
        db.prepare("UPDATE checkouts SET cupom_id = NULL, status = 'iniciado' WHERE id = ?").run(ck.id);
        return erro(res, 409, `${pr.cupomCaiu} O valor voltou para o preço normal. Confira e tente de novo.`, { cupom_caiu: true });
      }
      const p = pr.plano;
      const pix = await asaas.cobrarPix({
        cliente, valor: pr.total, descricao: `${p.nome} — 1º ano (Pix)${pr.cupom ? ` · cupom ${pr.cupom.codigo}` : ''}`, referencia: `checkout:${ck.id.slice(0, 12)}`,
      });
      db.prepare("UPDATE checkouts SET status = 'aguardando_pix', forma = 'pix', asaas_pagamento_id = ?, pix_qr = ?, pix_copia_e_cola = ? WHERE id = ?")
        .run(pix.pagamento_id, pix.qr_imagem, pix.copia_e_cola, ck.id);
      res.json({ status: 'aguardando_pix', qr_imagem: pix.qr_imagem, copia_e_cola: pix.copia_e_cola });
    } catch (e) {
      db.prepare("UPDATE checkouts SET status = 'iniciado' WHERE id = ? AND status = 'processando'").run(ck.id);
      // Erro do Pix é da conta do Asaas (ex.: sem chave Pix cadastrada), não do cliente: o motivo vai só para o log
      if (e instanceof asaas.ErroAsaas) {
        console.error('[checkout] Pix recusado pelo Asaas:', e.message);
        return erro(res, 502, 'O Pix está indisponível no momento. Pague com o cartão ou tente de novo mais tarde.');
      }
      console.error('[checkout] pix:', e.message);
      erro(res, 500, 'Não foi possível gerar o Pix. Tente de novo.');
    }
  });

  async function verificarPix(ck) {
    if (ck?.status !== 'aguardando_pix' || !ck.asaas_pagamento_id) return;
    const p = await asaas.consultarPagamento(ck.asaas_pagamento_id);
    if (!asaas.PAGO.includes(p.status)) return;
    pixPago(ck, p);
  }
  function pixPago(ck, p) {
    const hoje = agoraBrasilia().hoje;
    confirmarPagamento(ck.id, {
      forma: 'pix',
      cobrancas: [{ provedor_cobranca_id: ck.asaas_pagamento_id, valor: p.value ?? precoDo(ck).total, vencimento: hoje, status: 'paga', pago_em: p.paymentDate || hoje, forma: 'pix' }],
    });
  }

  // Webhook do Asaas: Pix do checkout pago → ativa (antes de pagamentos.js aplicar o evento)
  pagamentos.aoEvento((ev, provedor) => {
    if (provedor !== 'asaas' || ev.tipo !== 'cobranca_paga' || !ev.provedor_cobranca_id) return;
    const ck = db.prepare("SELECT * FROM checkouts WHERE asaas_pagamento_id = ? AND status = 'aguardando_pix'").get(ev.provedor_cobranca_id);
    if (ck) pixPago(ck, { value: ev.valor, paymentDate: ev.pago_em });
  });

  // Acompanhamento (o front consulta a cada poucos segundos enquanto o Pix não cai)
  app.get('/checkout/:id/status', limStatus, async (req, res) => {
    let ck = buscar(req.params.id);
    if (!ck) return erro(res, 404, 'Checkout não encontrado.');
    if (ck.status === 'aguardando_pix') {
      try { await verificarPix(ck); } catch (e) { console.warn('[checkout] consulta do Pix:', e.message); }
      ck = buscar(ck.id);
    }
    res.json({ status: ck.status, nome: ck.nome, email: ck.email, forma: ck.forma });
  });

  // ── 4. Ativação: cria a senha e já devolve a sessão ──
  app.post('/checkout/:id/ativar', limCheckout, async (req, res) => {
    const ck = buscar(req.params.id);
    if (!ck || !ck.usuario_id) return erro(res, 404, 'Pagamento não encontrado.');
    if (ck.status === 'ativado') return erro(res, 409, 'Sua conta já está ativa. Entre com o seu e-mail e senha.', { conta: true });
    if (ck.status !== 'pago') return erro(res, 400, 'O pagamento ainda não foi confirmado.');
    const problema = erroSenha(req.body.senha);
    if (problema) return erro(res, 400, problema);
    const senha_hash = await bcrypt.hash(req.body.senha, 10);
    const r = db.prepare("UPDATE checkouts SET status = 'ativado', ativado_em = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pago'").run(ck.id);
    if (!r.changes) return erro(res, 409, 'Sua conta já está ativa. Entre com o seu e-mail e senha.', { conta: true });
    db.prepare('UPDATE usuarios SET senha_hash = ?, sessao_versao = sessao_versao + 1 WHERE id = ?').run(senha_hash, ck.usuario_id);
    const u = db.prepare('SELECT id, nome, email, sessao_versao FROM usuarios WHERE id = ?').get(ck.usuario_id);
    res.json({ token: gerarToken(u), nome: u.nome, email: u.email });
  });

  // ── Aviso de renovação: 7 dias antes do fim do ciclo, para quem renova no Asaas ──
  async function avisarRenovacoes() {
    const hoje = agoraBrasilia().hoje;
    const limite = new Date(`${hoje}T12:00:00Z`); limite.setUTCDate(limite.getUTCDate() + DIAS_AVISO_RENOVACAO);
    const ate = limite.toISOString().slice(0, 10);
    const lista = db.prepare(`SELECT a.id, a.ciclo, a.fim_ciclo, a.cartao_token, u.nome, u.email, p.nome AS plano, p.valor_anual, p.parcelas
      FROM assinaturas a JOIN usuarios u ON u.id = a.usuario_id JOIN planos p ON p.id = a.plano_id
      WHERE a.provedor = 'asaas' AND a.renovacao_automatica = 1 AND a.status IN ('ativa', 'inadimplente')
        AND a.fim_ciclo >= ? AND a.fim_ciclo <= ? AND (a.aviso_renovacao_ciclo IS NULL OR a.aviso_renovacao_ciclo < a.ciclo)`).all(hoje, ate);
    for (const a of lista) {
      db.prepare('UPDATE assinaturas SET aviso_renovacao_ciclo = ? WHERE id = ?').run(a.ciclo, a.id);
      const [ano, mes, dia] = a.fim_ciclo.split('-');
      const parcela = (Math.round((a.valor_anual / a.parcelas) * 100) / 100).toFixed(2).replace('.', ',');
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 0;">
          <div style="background:#181818;border-radius:14px;padding:32px;color:#f4f5f0;">
            <h2 style="margin:0 0 8px;">Olá, ${escaparHtml(a.nome.split(' ')[0])}!</h2>
            <p style="color:#a3a8a0;font-size:14px;line-height:1.6;margin:0;">
              O seu ano de Zevem termina em ${dia}/${mes}/${ano}. ${a.cartao_token
                ? `No dia seguinte, a assinatura renova sozinha no mesmo cartão, em ${a.parcelas}x de R$ ${parcela}.`
                : 'Para continuar, você vai receber um link para pagar a renovação.'}<br><br>
              Se não quiser renovar, peça o cancelamento pelo app (Minha assinatura) ou responda este e-mail.</p>
          </div>
        </div>`;
      try { await enviarEmail(a.email, 'Sua assinatura do Zevem renova em breve', html); }
      catch (e) { console.warn(`[checkout] aviso de renovação (assinatura ${a.id}):`, e.message); }
    }
  }
  setTimeout(() => avisarRenovacoes().catch((e) => console.error('[checkout]', e)), 15000);
  setInterval(() => avisarRenovacoes().catch((e) => console.error('[checkout]', e)), 6 * 60 * 60 * 1000);
};
