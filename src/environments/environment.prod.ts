// Endereço do backend em produção. Padrão: /api no mesmo domínio (o nginx da VPS encaminha para o
// backend; ver deploy/). Para outro endereço: `API_URL=https://api.exemplo.com npm run build`
// (scripts/build.mjs troca ZEVEM_API_URL na hora do build).
declare const ZEVEM_API_URL: string | undefined;

export const environment = {
  production: true,
  semLogin: false,
  apiUrl: typeof ZEVEM_API_URL === 'string' ? ZEVEM_API_URL : '/api',
};
