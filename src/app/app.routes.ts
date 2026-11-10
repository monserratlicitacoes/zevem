import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { Login } from './pages/login/login';
import { Cadastro } from './pages/cadastro/cadastro';
import { ConfirmarEmail } from './pages/confirmar-email/confirmar-email';
import { RedefinirSenha } from './pages/redefinir-senha/redefinir-senha';
import { Configuracoes } from './pages/configuracoes/configuracoes';
import { Recebimentos } from './pages/recebimentos/recebimentos';
import { Gastos } from './pages/gastos/gastos';
import { Dividas } from './pages/dividas/dividas';
// import { AtivosPassivos } from './pages/ativos-passivos/ativos-passivos'; // desativado, ver rota abaixo
import { Sonhos } from './pages/sonhos/sonhos';
import { GestaoGastos } from './pages/gestao-gastos/gestao-gastos';
import { Dashboard } from './pages/dashboard/dashboard';
import { Alertas } from './pages/alertas/alertas';
import { masterGuard } from './guards/master.guard';
import { AdminClientes } from './pages/admin/clientes/admin-clientes';
import { AdminAnuncios } from './pages/admin/anuncios/admin-anuncios';
import { AdminFinanceiro } from './pages/admin/financeiro/admin-financeiro';
import { AdminIndicadores } from './pages/admin/indicadores/admin-indicadores';
import { AdminConvites } from './pages/admin/convites/admin-convites';
import { AdminVideos } from './pages/admin/videos/admin-videos';

export const routes: Routes = [
  { path: 'login', component: Login },
  { path: 'cadastro', component: Cadastro },
  { path: 'confirmar-email', component: ConfirmarEmail },
  { path: 'redefinir-senha', component: RedefinirSenha }, // sem token: pede o e-mail; com token (link do e-mail): nova senha
  { path: 'dashboard', component: Dashboard, canActivate: [authGuard] },
  { path: 'configuracoes', component: Configuracoes, canActivate: [authGuard] },
  { path: 'recebimentos', component: Recebimentos, canActivate: [authGuard] },
  { path: 'gastos', component: Gastos, canActivate: [authGuard] },
  { path: 'gestao-gastos', component: GestaoGastos, canActivate: [authGuard] },
  { path: 'dividas', component: Dividas, canActivate: [authGuard] },
  // DESATIVADO por enquanto: Ativos & Passivos fora do app (dados e backend intactos). Para reativar, descomente esta linha,
  // o import acima e o link no menu (shared/sidebar/sidebar.html).
  // { path: 'ativos-passivos', component: AtivosPassivos, canActivate: [authGuard] },
  { path: 'sonhos', component: Sonhos, canActivate: [authGuard] },
  // Alertas fica na área master (menu Master)
  { path: 'alertas', component: Alertas, canActivate: [authGuard, masterGuard] },

  // Área master
  { path: 'admin/clientes', component: AdminClientes, canActivate: [authGuard, masterGuard] },
  { path: 'admin/convites', component: AdminConvites, canActivate: [authGuard, masterGuard] },
  { path: 'admin/anuncios', component: AdminAnuncios, canActivate: [authGuard, masterGuard] },
  { path: 'admin/videos', component: AdminVideos, canActivate: [authGuard, masterGuard] },
  { path: 'admin/financeiro', component: AdminFinanceiro, canActivate: [authGuard, masterGuard] },
  { path: 'admin/indicadores', component: AdminIndicadores, canActivate: [authGuard, masterGuard] },

  { path: '', redirectTo: 'recebimentos', pathMatch: 'full' },
  { path: '**', redirectTo: 'recebimentos' },
];
