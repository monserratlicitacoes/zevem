// Fila de saída: busca os avisos do Zevem, envia pelo provedor e confirma (enviado | falhou).
// Dentro da janela de 24h da última mensagem do usuário, sai como texto livre; fora, como template.
const { chaveTelefone, paraEnvio, mascarar } = require('./telefone');
const { parametrosTemplate } = require('./templates');

const JANELA_MS = 23.5 * 3_600_000; // margem de 30 min antes de a Meta fechar a janela
const MAX_FALHAS_TEMPORARIAS = 3;   // depois disso o aviso é confirmado como falhou

module.exports = function criarFila({ estado, provedor, zevem, config, log = console }) {
  async function confirmar(aviso, envioId, dados) {
    try {
      await zevem.status(aviso.id, dados);
    } catch (e) {
      // 404 = já confirmado antes. Outros erros: o aviso volta à fila em 10 min e o envio local evita duplicar.
      if (e.status !== 404) { log.warn(`[fila] confirmar aviso ${aviso.id}: ${e.message}`); return; }
    }
    if (envioId) estado.marcarEnvioConfirmado(envioId);
  }

  async function enviar(aviso, destino) {
    const contato = estado.contato(chaveTelefone(aviso.telefone));
    const dentroDaJanela = config.janelaTextoLivre && contato && Date.now() - contato.ultima_recebida_em < JANELA_MS;
    const usaTemplate = provedor.suportaTemplates && aviso.template;
    if (dentroDaJanela || !usaTemplate) {
      try {
        return { forma: 'texto', ...(await provedor.enviarTexto(destino, aviso.mensagem)) };
      } catch (e) {
        if (!(e.janelaFechada && usaTemplate)) throw e;
      }
    }
    const parametros = parametrosTemplate(aviso.template, aviso.variaveis);
    return { forma: 'template', ...(await provedor.enviarTemplate(destino, aviso.template, config.idiomaTemplates, parametros)) };
  }

  async function processarAviso(aviso) {
    // Já saiu numa rodada anterior e só a confirmação se perdeu: confirma sem mandar de novo
    const feito = estado.envioJaFeito(aviso.id);
    if (feito) return confirmar(aviso, feito.id, { status: 'enviado', mensagem_id_provedor: feito.provedor_id });

    const contato = estado.contato(chaveTelefone(aviso.telefone));
    const destino = contato?.destino || paraEnvio(aviso.telefone);
    if (!destino) {
      const id = estado.registrarEnvio({ aviso_id: aviso.id, status: 'falhou', erro: 'Telefone inválido' });
      return confirmar(aviso, id, { status: 'falhou', erro: 'Telefone inválido' });
    }
    try {
      const r = await enviar(aviso, destino);
      const id = estado.registrarEnvio({ aviso_id: aviso.id, destino, forma: r.forma, provedor_id: r.id, status: 'enviado' });
      log.info(`[fila] aviso ${aviso.id} (${aviso.tipo}) → ${mascarar(destino)} por ${r.forma}`);
      await confirmar(aviso, id, { status: 'enviado', mensagem_id_provedor: r.id });
    } catch (e) {
      const id = estado.registrarEnvio({ aviso_id: aviso.id, destino, status: 'falhou', erro: e.message });
      // Falha temporária: não confirma; a reserva vence em 10 min e o Zevem entrega o aviso de novo
      if (e.temporario && estado.falhasDoAviso(aviso.id) < MAX_FALHAS_TEMPORARIAS) {
        log.warn(`[fila] aviso ${aviso.id} falhou (vai tentar de novo): ${e.message}`);
        return;
      }
      log.error(`[fila] aviso ${aviso.id} falhou: ${e.message}`);
      await confirmar(aviso, id, { status: 'falhou', erro: e.message.slice(0, 500) });
    }
  }

  let rodando = false;
  async function rodar() {
    if (rodando) return 0; // uma rodada por vez
    rodando = true;
    try {
      const avisos = await zevem.saida(config.fila.limite);
      for (const a of avisos) await processarAviso(a);
      return avisos.length;
    } catch (e) {
      log.warn(`[fila] busca falhou: ${e.message}`);
      return 0;
    } finally {
      rodando = false;
    }
  }

  return { rodar, processarAviso };
};
