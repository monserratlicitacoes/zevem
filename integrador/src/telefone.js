// O WhatsApp entrega o número com DDI (55) e, em alguns celulares, sem o 9 depois do DDD.
// Mesma chave do backend (backend/whatsapp.js): DDD + últimos 8 dígitos, que bate nos dois formatos.
function chaveTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10) return '';
  return d.slice(0, 2) + d.slice(-8);
}

// Número para envio: a fila do Zevem entrega o telefone como cadastrado (normalmente sem o 55)
function paraEnvio(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12) return d;
  return '';
}

// Para logs: nunca grava o número inteiro
const mascarar = (t) => {
  const d = String(t || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : '-';
};

module.exports = { chaveTelefone, paraEnvio, mascarar };
