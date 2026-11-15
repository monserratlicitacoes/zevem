// Build de produção do front. Sem API_URL o app chama o backend em /api no mesmo domínio (como na VPS,
// ver deploy/). Para outro endereço: `API_URL=https://api.exemplo.com npm run build` — entra no código
// no lugar de ZEVEM_API_URL (environment.prod.ts).
// Os demais argumentos vão direto para o `ng build` (ex.: `npm run build -- --configuration development`).
import { spawnSync } from 'node:child_process';

const url = (process.env.API_URL || '').trim().replace(/\/+$/, '');

if (!url) {
  console.log('Backend: /api no mesmo domínio (padrão). Para outro endereço, defina API_URL.');
} else if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
  console.error(`API_URL inválida: "${url}". Use https://… (ou http://localhost para teste).`);
  process.exit(1);
} else if (/SEU-BACKEND/i.test(url)) {
  console.error('API_URL ainda é o endereço de exemplo (SEU-BACKEND). Informe o endereço real do backend.');
  process.exit(1);
} else {
  console.log(`Backend: ${url}`);
}

const define = url ? ['--define', `ZEVEM_API_URL=${JSON.stringify(url)}`] : [];
const r = spawnSync('npx', ['ng', 'build', ...define, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
