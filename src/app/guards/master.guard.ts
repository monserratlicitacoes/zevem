import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

// Rotas da área master: só para usuários com papel master (o backend confere de novo em cada rota)
export const masterGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isLoggedIn) return router.createUrlTree(['/login']);
  return auth.carregarPapel().pipe(map((m) => (m ? true : router.createUrlTree(['/dashboard']))));
};
