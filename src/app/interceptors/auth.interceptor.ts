import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

const ROTAS_AUTH = ['/auth/login', '/auth/cadastro', '/auth/confirmar-email', '/auth/dev-login', '/auth/esqueci-senha', '/auth/redefinir-senha'];

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const rotaAuth = ROTAS_AUTH.some((r) => req.url.includes(r));
  const token = localStorage.getItem('token');
  const comToken = token && !rotaAuth ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(comToken).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status !== 401 || rotaAuth) return throwError(() => err);
      // Sessão salva foi recusada pelo backend: no modo local sem login, entra de novo e repete o pedido.
      if (environment.semLogin) {
        localStorage.removeItem('token');
        return auth.devLogin().pipe(
          switchMap((res) => next(req.clone({ setHeaders: { Authorization: `Bearer ${res.token}` } }))),
        );
      }
      auth.logout();
      return throwError(() => err);
    }),
  );
};
