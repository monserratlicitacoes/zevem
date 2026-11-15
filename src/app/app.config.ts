import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { NavigationError, provideRouter, withNavigationErrorHandler } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { authInterceptor } from './interceptors/auth.interceptor';

// Mensagens dos navegadores quando uma tela carregada sob demanda não chega
// (versão nova publicada com o app aberto, ou servidor fora do ar).
const FALHA_DE_CARGA = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i;
const CHAVE_RECARGA = 'zevem-recarga-tela';

// Recarrega a página já no endereço pedido, no máximo uma vez a cada 30 s para não entrar em laço.
function recarregarSeTelaNaoCarregou(erro: NavigationError): void {
  const msg = String((erro.error as Error | undefined)?.message ?? erro.error ?? '');
  if (!FALHA_DE_CARGA.test(msg)) return;
  let ultima = 0;
  try { ultima = Number(sessionStorage.getItem(CHAVE_RECARGA)) || 0; } catch {}
  if (Date.now() - ultima < 30_000) return;
  try { sessionStorage.setItem(CHAVE_RECARGA, String(Date.now())); } catch {}
  location.assign(erro.url);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withNavigationErrorHandler(recarregarSeTelaNaoCarregou)),
    provideHttpClient(withInterceptors([authInterceptor])),
  ]
};
