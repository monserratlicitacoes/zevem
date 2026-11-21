// Mensagens recebidas: webhook → estado local → (transcrição) → Zevem → resposta ao usuário.
// O webhook só grava e responde 200; o processamento roda aqui, em série, com novas tentativas.
const { chaveTelefone, mascarar } = require('./telefone');

const ESPERAS_MS = [2_000, 10_000, 30_000, 60_000, 120_000]; // entre tentativas
const MAX_TENTATIVAS = ESPERAS_MS.length + 1;
const LIMITE_TEXTO = 4_000; // o backend recusa corpo acima de ~5.000 caracteres

const RESPOSTA_NAO_SUPORTADA = 'Por enquanto eu só entendo mensagens de texto e áudio. Pode mandar por escrito?';
const RESPOSTA_FALHA = 'Tive um problema para processar sua mensagem agora. Pode tentar de novo em alguns minutos?';

module.exports = function criarEntrada({ estado, provedor, zevem, transcricao, log = console }) {
  // Grava as mensagens novas do webhook. Devolve quantas eram novas (repetições do provedor são ignoradas).
  function registrar(mensagens) {
    let novas = 0;
    for (const m of mensagens) {
      estado.salvarContato(chaveTelefone(m.telefone), m.destino, Date.parse(m.recebida_em) || Date.now());
      if (!estado.registrarEntrada(m, provedor.nome)) continue;
      novas++;
      // Dois tiques azuis assim que chega: o usuário sabe que foi recebida
      provedor.marcarLida?.(m.id).catch((e) => log.warn(`[entrada] marcar lida ${m.id}: ${e.message}`));
    }
    return novas;
  }

  async function transcrever(e) {
    if (!e.midia_id || !transcricao.configurado) return '';
    const { dados, mime } = await provedor.baixarMidia(e.midia_id);
    return transcricao.transcrever(dados, mime);
  }

  async function processar(e) {
    try {
      if (e.estado === 'recebida') {
        let resposta;
        if (e.tipo === 'outro') {
          resposta = RESPOSTA_NAO_SUPORTADA;
        } else {
          let texto = e.texto || '';
          if (e.tipo === 'audio' && !e.transcrito) {
            try {
              texto = await transcrever(e);
            } catch (err) {
              // Falha temporária: tenta de novo; definitiva: segue vazio e o Zevem pede para mandar por texto
              if (err.temporario !== false && e.tentativas + 1 < MAX_TENTATIVAS) throw err;
              log.warn(`[entrada] áudio ${e.id} sem transcrição: ${err.message}`);
              texto = '';
            }
            estado.salvarTranscricao(e.id, texto);
          }
          const r = await zevem.mensagem({
            mensagem_id: e.id, telefone: e.telefone, tipo: e.tipo, texto: texto.slice(0, LIMITE_TEXTO), recebida_em: e.recebida_em,
          });
          resposta = r.resposta || '';
          log.info(`[entrada] ${e.id} de ${mascarar(e.telefone)}: ${r.acao || '-'}${r.repetida ? ' (repetida)' : ''}`);
        }
        estado.marcarProcessada(e.id, resposta);
        e = { ...e, estado: 'processada', resposta };
      }
      if (e.estado === 'processada') {
        // Resposta guardada e ainda não entregue: envia uma única vez
        const r = e.resposta ? await provedor.enviarTexto(e.destino, e.resposta) : { id: null };
        estado.marcarRespondida(e.id, r.id);
      }
    } catch (err) {
      const tentativas = e.tentativas + 1;
      if (err.temporario !== false && tentativas < MAX_TENTATIVAS) {
        estado.reagendar(e.id, tentativas, Date.now() + ESPERAS_MS[tentativas - 1], err.message);
        log.warn(`[entrada] ${e.id} tentativa ${tentativas} falhou, nova em ${ESPERAS_MS[tentativas - 1] / 1000}s: ${err.message}`);
        return;
      }
      estado.marcarFalha(e.id, err.message);
      log.error(`[entrada] ${e.id} desistiu após ${tentativas} tentativa(s): ${err.message}`);
      // Não ficou sem resposta: avisa o usuário (só se o Zevem não chegou a responder)
      if (e.estado === 'recebida') {
        await provedor.enviarTexto(e.destino, RESPOSTA_FALHA).catch((x) => log.error(`[entrada] aviso de falha ${e.id}: ${x.message}`));
      }
    }
  }

  // Processa tudo o que estiver pendente. Chamadas simultâneas não sobrepõem: a segunda pede outra volta
  // e espera a rodada em curso terminar.
  let atual = null, deNovo = false;
  async function rodada() {
    do {
      deNovo = false;
      for (const e of estado.entradasPendentes()) await processar(e);
    } while (deNovo);
  }
  function processarPendentes() {
    if (atual) { deNovo = true; return atual; }
    // .finally roda depois da atribuição, mesmo quando a rodada termina sem nenhum await
    atual = rodada().finally(() => { atual = null; });
    return atual;
  }

  return { registrar, processarPendentes, RESPOSTA_NAO_SUPORTADA, RESPOSTA_FALHA };
};
