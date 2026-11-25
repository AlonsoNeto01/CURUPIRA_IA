import Dexie, { type Table } from 'dexie';
import type {
  FocoIncendio,
  MunicipioIBGE,
  PrevisaoIA,
  SerieDiariaItem,
  ZonaRiscoEspacial,
} from './supabase';

export interface OcorrenciaOutbox {
  local_id?: number;
  codigo_ibge: string;
  municipio: string;
  lat: number;
  lon: number;
  local_referencia: string;
  porte: string;
  observacoes: string;
  registado_em: string;
}

class CurupiraOfflineDB extends Dexie {
  municipios!: Table<MunicipioIBGE, string>;
  focos!: Table<FocoIncendio, string>;
  previsoes!: Table<PrevisaoIA, number>;
  serieDiaria!: Table<SerieDiariaItem, number>;
  zonasRisco!: Table<ZonaRiscoEspacial, number>;
  outboxCampo!: Table<OcorrenciaOutbox, number>;

  constructor() {
    super('CurupiraOfflineDB');
    this.version(3).stores({
      municipios: 'codigo_ibge',
      focos: 'id, codigo_ibge, registado_em',
      previsoes: 'id, codigo_ibge, data_referencia',
      serieDiaria: 'id, codigo_ibge, data',
      zonasRisco: 'id, codigo_ibge, score_risco',
      outboxCampo: '++local_id, codigo_ibge, registado_em',
    });
  }
}

export const offlineDB = new CurupiraOfflineDB();
