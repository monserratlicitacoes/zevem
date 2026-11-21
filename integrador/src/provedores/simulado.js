// Provedor de testes: não fala com nenhum WhatsApp. Recebe mensagens por POST /webhook com
//   { "id": "opcional", "telefone": "5511999998888", "texto": "almoço 45", "tipo": "texto" }
// e guarda o que "enviaria" em memória (GET /simulado/enviadas). Só para desenvolvimento local.
const crypto = require('node:crypto');

module.exports = function criarSimulado() {
  const enviadas = [];
  let seq = 0;
  const registrar = (item) => {
    const id = `sim.${++seq}`;
    enviadas.push({ id, em: new Date().toISOString(), ...item });
    if (enviadas.length > 500) enviadas.shift();
    return { id };
  };

  return {
    nome: 'simulado',
    configurado: true,
    suportaTemplates: true,
    enviadas,
    desafio: (query) => (query['hub.challenge'] !== undefined ? String(query['hub.challenge']) : null),
    validarRequisicao: () => true,
    extrairEventos(corpo) {
      const lista = Array.isArray(corpo) ? corpo : [corpo];
      const mensagens = lista.filter((m) => m && m.telefone).map((m) => ({
        id: String(m.id || `sim.in.${crypto.randomUUID()}`),
        telefone: String(m.telefone), destino: String(m.telefone),
        tipo: ['texto', 'audio', 'outro'].includes(m.tipo) ? m.tipo : 'texto',
        tipo_original: m.tipo || 'texto',
        texto: String(m.texto || ''), midia_id: m.midia_id || null,
        recebida_em: m.recebida_em || new Date().toISOString(),
      }));
      return { mensagens, status: [] };
    },
    async baixarMidia() {
      throw Object.assign(new Error('Provedor simulado não tem mídia'), { temporario: false });
    },
    enviarTexto: async (destino, texto) => registrar({ destino, forma: 'texto', texto }),
    enviarTemplate: async (destino, nome, idioma, parametros) => registrar({ destino, forma: 'template', template: nome, idioma, parametros }),
    marcarLida: async () => {},
  };
};
