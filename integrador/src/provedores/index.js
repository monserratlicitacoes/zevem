// ── Provedores do WhatsApp ──
// Cada provedor é um adaptador com a mesma interface. O resto do integrador não sabe qual está ativo:
// trocar de provedor = definir WHATSAPP_PROVEDOR (e as variáveis dele) e reiniciar o serviço.
//
// Para criar um provedor novo (backup), crie src/provedores/<nome>.js exportando
// `function criar(config) → adaptador` e registre-o em PROVEDORES abaixo. O adaptador tem:
//
//   nome: string
//   configurado: boolean                  falso = webhook responde 503 e a fila não roda
//   suportaTemplates: boolean             falso = avisos sempre saem com o texto pronto (`mensagem`)
//   desafio(query) → string | null        verificação do webhook (GET); null = recusar
//   validarRequisicao(headers, corpoBruto: Buffer) → boolean   assinatura do POST do webhook
//   extrairEventos(corpo) → { mensagens: Mensagem[], status: Status[] }
//       Mensagem: { id, telefone, destino, tipo: 'texto'|'audio'|'outro', tipo_original, texto, midia_id, recebida_em (ISO) }
//                 mensagens que não pedem resposta (reação, sistema) não devem ser devolvidas
//       Status:   { provedor_id, status: 'enviado'|'entregue'|'lido'|'falhou_entrega', erro }
//   baixarMidia(midiaId) → Promise<{ dados: Buffer, mime: string }>
//   enviarTexto(destino, texto) → Promise<{ id }>
//   enviarTemplate(destino, nome, idioma, parametros: string[]) → Promise<{ id }>
//   marcarLida?(mensagemId) → Promise<void>         opcional
//
// Erros de envio devem ter `temporario` (true = vale tentar de novo) e, quando a janela de 24h estiver
// fechada para texto livre, `janelaFechada = true` (o integrador cai para o template).

const PROVEDORES = {
  meta: require('./meta'),
  simulado: require('./simulado'),
};

function criarProvedor(nome, config) {
  const criar = PROVEDORES[nome];
  if (!criar) throw new Error(`WHATSAPP_PROVEDOR desconhecido: "${nome}". Opções: ${Object.keys(PROVEDORES).join(', ')}`);
  return criar(config);
}

module.exports = { criarProvedor, PROVEDORES };
