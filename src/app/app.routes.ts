import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { Login } from './pages/login/login';
import { masterGuard } from './guards/master.guard';
import { planejadorGuard } from './guards/planejador.guard';

// Só o login vai no pacote inicial; as demais telas são baixadas quando abertas (app mais leve na entrada).
// Se uma tela não chegar (versão nova publicada), o app recarrega sozinho (ver app.config.ts).
export const routes: Routes = [
  { path: 'login', component: Login },
  { path: 'cadastro', loadComponent: () => import('./pages/cadastro/cadastro').then((m) => m.Cadastro) },
  { path: 'assinar', loadComponent: () => import('./pages/assinar/assinar').then((m) => m.Assinar) }, // página pública de venda
  { path: 'confirmar-email', loadComponent: () => import('./pages/confirmar-email/confirmar-email').then((m) => m.ConfirmarEmail) },
  { path: 'redefinir-senha', loadComponent: () => import('./pages/redefinir-senha/redefinir-senha').then((m) => m.RedefinirSenha) }, // sem token: pede o e-mail; com token (link do e-mail): nova senha
  { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.Dashboard), canActivate: [authGuard] },
  { path: 'configuracoes', loadComponent: () => import('./pages/configuracoes/configuracoes').then((m) => m.Configuracoes), canActivate: [authGuard] },
  { path: 'recebimentos', loadComponent: () => import('./pages/recebimentos/recebimentos').then((m) => m.Recebimentos), canActivate: [authGuard] },
  { path: 'gastos', loadComponent: () => import('./pages/gastos/gastos').then((m) => m.Gastos), canActivate: [authGuard] },
  { path: 'gestao-gastos', loadComponent: () => import('./pages/gestao-gastos/gestao-gastos').then((m) => m.GestaoGastos), canActivate: [authGuard] },
  { path: 'dividas', loadComponent: () => import('./pages/dividas/dividas').then((m) => m.Dividas), canActivate: [authGuard] },
  // DESATIVADO por enquanto: Ativos & Passivos fora do app (dados e backend intactos). Para reativar, descomente esta linha
  // e o link no menu (shared/sidebar/sidebar.html).
  // { path: 'ativos-passivos', loadComponent: () => import('./pages/ativos-passivos/ativos-passivos').then((m) => m.AtivosPassivos), canActivate: [authGuard] },
  { path: 'sonhos', loadComponent: () => import('./pages/sonhos/sonhos').then((m) => m.Sonhos), canActivate: [authGuard] },
  // Alertas fica na área master (menu Master)
  { path: 'alertas', loadComponent: () => import('./pages/alertas/alertas').then((m) => m.Alertas), canActivate: [authGuard, masterGuard] },

  // Área master
  { path: 'admin/clientes', loadComponent: () => import('./pages/admin/clientes/admin-clientes').then((m) => m.AdminClientes), canActivate: [authGuard, masterGuard] },
  { path: 'admin/convites', loadComponent: () => import('./pages/admin/convites/admin-convites').then((m) => m.AdminConvites), canActivate: [authGuard, masterGuard] },
  { path: 'admin/planejadores', loadComponent: () => import('./pages/admin/planejadores/admin-planejadores').then((m) => m.AdminPlanejadores), canActivate: [authGuard, masterGuard] },
  { path: 'admin/anuncios', loadComponent: () => import('./pages/admin/anuncios/admin-anuncios').then((m) => m.AdminAnuncios), canActivate: [authGuard, masterGuard] },
  { path: 'admin/videos', loadComponent: () => import('./pages/admin/videos/admin-videos').then((m) => m.AdminVideos), canActivate: [authGuard, masterGuard] },
  { path: 'admin/financeiro', loadComponent: () => import('./pages/admin/financeiro/admin-financeiro').then((m) => m.AdminFinanceiro), canActivate: [authGuard, masterGuard] },
  { path: 'admin/indicadores', loadComponent: () => import('./pages/admin/indicadores/admin-indicadores').then((m) => m.AdminIndicadores), canActivate: [authGuard, masterGuard] },

  // Área do planejador financeiro associado
  { path: 'planejador/clientes', loadComponent: () => import('./pages/planejador/clientes/planejador-clientes').then((m) => m.PlanejadorClientes), canActivate: [authGuard, planejadorGuard] },

  { path: '', redirectTo: 'recebimentos', pathMatch: 'full' },
  { path: '**', redirectTo: 'recebimentos' },
];
