import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface PerfilUsuario {
  user_id: string;
  codigo_ibge: string;
  nome_completo: string;
  cargo: string | null;
  role: 'super_admin' | 'gestor_prefeitura' | 'brigadista' | 'auditor_leitura';
}

export interface MunicipioIBGE {
  codigo_ibge: string;
  nome: string;
  uf: string;
  bbox_w: number;
  bbox_s: number;
  bbox_e: number;
  bbox_n: number;
  pontos_grade: [number, number][];
}

export interface FocoIncendio {
  id: string;
  codigo_ibge: string;
  municipio: string;
  lat: number;
  lon: number;
  temperatura_k: number | null;
  frp_mw: number;
  satelite: string;
  confianca: string;
  origem: 'SATELITE_NASA' | 'SATELITE_INPE' | 'CAMPO_BRIGADA';
  status_combate: 'ATIVO' | 'EM_COMBATE' | 'CONTROLADO' | 'FALSO_POSITIVO';
  jurisdicao_tipo: string | null;
  jurisdicao_nome: string | null;
  local_referencia: string | null;
  porte: string | null;
  observacoes: string | null;
  registado_em: string;
}

export interface PrevisaoIA {
  id: number;
  codigo_ibge: string;
  municipio: string;
  modelo_utilizado: string;
  data_referencia: string;
  focos_previstos_d1: number;
  focos_previstos_d2: number;
  focos_previstos_d3: number;
  ic_inf_d1: number;
  ic_sup_d1: number;
  ic_inf_d2: number;
  ic_sup_d2: number;
  ic_inf_d3: number;
  ic_sup_d3: number;
  prob_dia_critico_d1: number;
  prob_dia_critico_d2: number;
  prob_dia_critico_d3: number;
  vpd_kpa: number;
  indice_nesterov: number;
  indice_angstrom: number;
  umidade_solo_pct: number;
  dias_sem_chuva: number;
  nivel_risco: 'BAIXO' | 'MODERADO' | 'ALTO' | 'CRÍTICO';
  xai_fatores?: Record<string, number | boolean>;
  r2_validacao: number;
  mae_validacao: number;
  f1_validacao: number;
  atualizado_em: string;
}
