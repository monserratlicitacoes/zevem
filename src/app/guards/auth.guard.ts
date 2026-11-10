import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isLoggedIn) return true;
  if (environment.semLogin) {
    return auth.devLogin().pipe(
      map(() => true),
      catchError(() => of(router.createUrlTree(['/login']))),
    );
  }
  return router.createUrlTree(['/login']);
};
