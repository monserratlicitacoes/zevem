import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

// Área do planejador financeiro (o backend confere de novo em cada rota /planejador/*)
export const planejadorGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isLoggedIn) return router.createUrlTree(['/login']);
  return auth.carregarPapel().pipe(map(() => (auth.planejador() ? true : router.createUrlTree(['/dashboard']))));
};
