// ── Asaas: cliente da API e adaptador de pagamentos ──
//
// Configuração (.env / .env.production — nunca no código):
//   ASAAS_API_KEY        chave da API ($aact_...). Sem ela o checkout responde "pagamento indisponível".
//   ASAAS_AMBIENTE       sandbox (padrão) | producao
//   ASAAS_WEBHOOK_TOKEN  o mesmo "Token de autenticação" cadastrado no webhook do painel do Asaas
//   ASAAS_BASE_URL       (só para testes) troca o endereço da API, ex.: um simulador local
//
// Modelo de cobrança do Zevem: plano anual em 12x no cartão (uma compra parcelada no Asaas), ou à vista
// no Pix. O cartão fica guardado no Asaas (creditCardToken) e a renovação anual usa esse token.
// Dados do cartão passam por aqui só para seguir ao Asaas: nunca são gravados nem registrados em log.

const URLS = { sandbox: 'https://api-sandbox.asaas.com/v3', producao: 'https://api.asaas.com/v3' };

const configurado = () => !!process.env.ASAAS_API_KEY;
const baseUrl = () => process.env.ASAAS_BASE_URL || URLS[process.env.ASAAS_AMBIENTE === 'producao' ? 'producao' : 'sandbox'];

class ErroAsaas extends Error {
  constructor(status, mensagem, codigo) { super(mensagem); this.status = status; this.codigo = codigo; }
}

async function chamar(metodo, caminho, corpo) {
  if (!configurado()) throw new ErroAsaas(503, 'O pagamento ainda não está configurado.');
  let r;
  try {
    r = await fetch(`${baseUrl()}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Zevem', access_token: process.env.ASAAS_API_KEY },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new ErroAsaas(502, 'Não foi possível falar com o sistema de pagamento. Tente de novo em instantes.');
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    // O Asaas devolve { errors: [{ code, description }] } — a descrição é segura para mostrar ao cliente
    const e = dados?.errors?.[0];
    throw new ErroAsaas(r.status, e?.description || `Erro ${r.status} no sistema de pagamento.`, e?.code);
  }
  return dados;
}

const hojeISO = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // horário de Brasília
const somarDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function criarCliente({ nome, email, cpf, telefone, referencia }) {
  const c = await chamar('POST', '/customers', { name: nome, email, cpfCnpj: cpf, mobilePhone: telefone, externalReference: referencia });
  return c.id;
}

// Parcelas de uma compra parcelada, em ordem
async function parcelasDe(parcelamentoId) {
  const r = await chamar('GET', `/payments?installment=${encodeURIComponent(parcelamentoId)}&limit=24`);
  return (r.data || []).slice().sort((a, b) => (a.installmentNumber ?? 0) - (b.installmentNumber ?? 0) || a.dueDate.localeCompare(b.dueDate));
}

// Compra anual parcelada no cartão. cartao = { numero, nome, mes, ano, cvc } ou token = creditCardToken.
async function cobrarCartaoParcelado({ cliente, total, parcelas, descricao, referencia, cartao, token, titular, ip }) {
  const corpo = {
    customer: cliente, billingType: 'CREDIT_CARD', dueDate: hojeISO(), description: descricao, externalReference: referencia,
    installmentCount: parcelas, totalValue: total, remoteIp: ip,
  };
  if (token) corpo.creditCardToken = token;
  else {
    corpo.creditCard = { holderName: cartao.nome, number: cartao.numero, expiryMonth: cartao.mes, expiryYear: cartao.ano, ccv: cartao.cvc };
    corpo.creditCardHolderInfo = {
      name: titular.nome, email: titular.email, cpfCnpj: titular.cpf, postalCode: titular.cep, addressNumber: titular.numero, mobilePhone: titular.telefone,
    };
  }
  const p = await chamar('POST', '/payments', corpo);
  if (!['CONFIRMED', 'RECEIVED'].includes(p.status)) {
    throw new ErroAsaas(402, 'O pagamento não foi aprovado pelo cartão. Confira os dados ou use outro cartão.');
  }
  const lista = p.installment ? await parcelasDe(p.installment) : [p];
  return {
    pagamento_id: p.id,
    parcelamento_id: p.installment || null,
    cartao_token: p.creditCard?.creditCardToken || token || null,
    cartao_final: p.creditCard?.creditCardNumber || null,
    cartao_bandeira: p.creditCard?.creditCardBrand || null,
    parcelas: lista.map((x) => ({ provedor_cobranca_id: x.id, valor: x.value, vencimento: x.dueDate })),
  };
}

// Pix à vista: devolve a cobrança e o QR Code
async function cobrarPix({ cliente, valor, descricao, referencia }) {
  const p = await chamar('POST', '/payments', {
    customer: cliente, billingType: 'PIX', value: valor, dueDate: somarDias(hojeISO(), 1), description: descricao, externalReference: referencia,
  });
  const qr = await chamar('GET', `/payments/${p.id}/pixQrCode`);
  return { pagamento_id: p.id, qr_imagem: qr.encodedImage, copia_e_cola: qr.payload, expira_em: qr.expirationDate };
}

// Cobrança em que o cliente escolhe como pagar (renovação sem cartão guardado ou com o cartão recusado)
async function cobrarPorLink({ cliente, valor, descricao, referencia, dias = 5 }) {
  const p = await chamar('POST', '/payments', {
    customer: cliente, billingType: 'UNDEFINED', value: valor, dueDate: somarDias(hojeISO(), dias), description: descricao, externalReference: referencia,
  });
  return { provedor_cobranca_id: p.id, valor: p.value, vencimento: p.dueDate, link_pagamento: p.invoiceUrl };
}

const consultarPagamento = (id) => chamar('GET', `/payments/${encodeURIComponent(id)}`);
const cancelarCobranca = (id) => chamar('DELETE', `/payments/${encodeURIComponent(id)}`);
const PAGO = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'];

async function estornar({ parcelamento_id, pagamento_id }) {
  if (parcelamento_id) return chamar('POST', `/installments/${encodeURIComponent(parcelamento_id)}/refund`);
  return chamar('POST', `/payments/${encodeURIComponent(pagamento_id)}/refund`);
}

// ── Adaptador para pagamentos.js (PROVEDORES.asaas) ──
const provedor = {
  nome: 'Asaas',
  // Assinatura nova só nasce pelo checkout (precisa do cartão ou do Pix do cliente)
  async criarAssinatura() { throw new Error('Assinaturas do Asaas são criadas pelo checkout da página /assinar'); },

  // Ciclo novo: cobra 12x no cartão guardado; sem cartão (ou recusado), gera uma cobrança com link
  async renovarCiclo({ assinatura, plano }) {
    const descricao = `${plano.nome} — renovação (ano ${assinatura.ciclo + 1})`;
    const referencia = `assinatura:${assinatura.id}:ciclo:${assinatura.ciclo + 1}`;
    if (assinatura.cartao_token) {
      try {
        const r = await cobrarCartaoParcelado({
          cliente: assinatura.provedor_cliente_id, total: plano.valor_anual, parcelas: plano.parcelas, descricao, referencia,
          token: assinatura.cartao_token, ip: assinatura.ip_origem || '127.0.0.1',
        });
        return {
          parcelamento_id: r.parcelamento_id,
          cobrancas: r.parcelas.map((p) => ({ ...p, status: 'paga', pago_em: hojeISO(), forma: 'cartao' })),
        };
      } catch (e) {
        console.warn(`[asaas] renovação no cartão recusada (assinatura ${assinatura.id}): ${e.message}`);
      }
    }
    const c = await cobrarPorLink({ cliente: assinatura.provedor_cliente_id, valor: plano.valor_anual, descricao, referencia });
    return { cobrancas: [c], por_link: true };
  },

  // O Asaas não tem "assinatura" aqui (são compras parceladas): cancelar é só não renovar.
  // Cancelamento imediato também apaga no Asaas as cobranças em aberto (ex.: renovação por link não paga).
  async cancelarAssinatura({ abertas = [] }) {
    for (const c of abertas) {
      if (!c.provedor_cobranca_id) continue;
      try { await chamar('DELETE', `/payments/${encodeURIComponent(c.provedor_cobranca_id)}`); }
      catch (e) { console.warn(`[asaas] não deu para apagar a cobrança ${c.provedor_cobranca_id}: ${e.message}`); }
    }
  },

  // Estorno do ciclo atual: a compra parcelada inteira no cartão, ou cada cobrança paga (Pix/link)
  async estornarCiclo({ assinatura, pagas }) {
    const parcelamentos = new Set();
    const avulsas = [];
    for (const c of pagas) {
      if (c.forma_pagamento === 'cartao' && assinatura.provedor_parcelamento_id) parcelamentos.add(assinatura.provedor_parcelamento_id);
      else if (c.provedor_cobranca_id) avulsas.push(c.provedor_cobranca_id);
    }
    for (const id of parcelamentos) await estornar({ parcelamento_id: id });
    for (const id of avulsas) await estornar({ pagamento_id: id });
  },

  // Webhook: confere o token e traduz o evento
  interpretarWebhook(req) {
    const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
    if (!esperado || req.headers['asaas-access-token'] !== esperado) throw new Error('Token do webhook do Asaas inválido');
    const b = req.body || {};
    const p = b.payment;
    if (!p?.id) return [];
    const tipo = {
      PAYMENT_CONFIRMED: 'cobranca_paga', PAYMENT_RECEIVED: 'cobranca_paga',
      PAYMENT_OVERDUE: 'cobranca_vencida',
      PAYMENT_REFUNDED: 'cobranca_estornada', PAYMENT_CHARGEBACK_REQUESTED: 'cobranca_estornada', PAYMENT_DELETED: 'cobranca_estornada',
    }[b.event];
    if (!tipo) return [];
    return [{
      id: b.id || `${b.event}:${p.id}`, tipo, provedor_cobranca_id: p.id,
      valor: p.value, pago_em: p.paymentDate || p.confirmedDate || null,
      forma: p.billingType === 'CREDIT_CARD' ? 'cartao' : p.billingType === 'PIX' ? 'pix' : p.billingType === 'BOLETO' ? 'boleto' : null,
    }];
  },
};

module.exports = {
  configurado, ErroAsaas, criarCliente, cobrarCartaoParcelado, cobrarPix, cobrarPorLink, consultarPagamento, cancelarCobranca, estornar, PAGO, provedor, hojeISO,
};
