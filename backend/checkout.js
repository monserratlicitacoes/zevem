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
    normalizarEmail, emailValido, erroSenha, enviarEmail, escaparHtml, FRONTEND_URL, limitador, agoraBrasilia,
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
  `);

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
      const p = plano();
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
        parcelamento_id, cartao_token, ip: ck.ip, cobrancas,
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
      const cliente = await clienteAsaas(buscar(ck.id));
      const p = plano();
      const r = await asaas.cobrarCartaoParcelado({
        cliente, total: p.valor_anual, parcelas: p.parcelas, descricao: `${p.nome} — 1º ano`, referencia: `checkout:${ck.id.slice(0, 12)}`,
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
      const p = plano();
      const pix = await asaas.cobrarPix({ cliente, valor: p.valor_anual, descricao: `${p.nome} — 1º ano (Pix)`, referencia: `checkout:${ck.id.slice(0, 12)}` });
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
      cobrancas: [{ provedor_cobranca_id: ck.asaas_pagamento_id, valor: p.value ?? plano().valor_anual, vencimento: hoje, status: 'paga', pago_em: p.paymentDate || hoje, forma: 'pix' }],
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
