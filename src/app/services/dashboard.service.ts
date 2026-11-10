import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Grau de Comprometimento: X / renda mensal (ver /dashboard no backend)
export interface GrauComprometimento {
  renda: number;
  gastos_comprometidos: number;
  passivos_financeiros: number;
  passivos_imobilizados: number;
  parcelados_mes_seguinte: number;
  mes_parcelados: string; // AAAA-MM
  comprometido: number;   // X
  percentual: number | null; // null quando não há renda mensal cadastrada
}

// Nível de Saúde do Orçamento Familiar (1 a 9); componentes A..I em valores mensais
export interface NivelSaude {
  nivel: number | null; // null sem receita mensal
  motivo: string;
  componentes: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I', number>;
}

// Base de Plena Liquidez de uma pessoa: participação na renda mensal × pagamentos × Z × W
export interface BplPessoa {
  nome: string;
  renda: number;           // receita mensal da pessoa
  participacao: number;    // % da receita mensal total
  pagamentos: number;      // gastos mensalizados + PMT das dívidas
  peso_risco: number | null;      // Z (1 a 5)
  peso_facilidade: number | null; // W (1 a 1,5)
  faltando: string[];      // campos do cadastro sem preencher (valor fica 0)
  valor: number;
}

export interface DadosDashboard {
  base_plena_liquidez: BplPessoa[];
  limite_cartao: number; // soma mensal dos gastos pagos no cartão
  grau_comprometimento: GrauComprometimento;
  nivel_saude: NivelSaude;
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private api = environment.apiUrl;
  constructor(private http: HttpClient) {}

  obter(): Observable<DadosDashboard> {
    return this.http.get<DadosDashboard>(`${this.api}/dashboard`);
  }
}
