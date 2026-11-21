// Integrador WhatsApp do Zevem. Ver integrador/README.md.
const { iniciar } = require('./src/app');

const app = iniciar();
app.ouvir();

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    app.parar().finally(() => process.exit(0));
  });
}
