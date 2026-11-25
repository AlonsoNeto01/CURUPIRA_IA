import Dexie, { type Table } from 'dexie';
import type { FocoIncendio, MunicipioIBGE, PrevisaoIA } from './supabase';

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
  outboxCampo!: Table<OcorrenciaOutbox, number>;

  constructor() {
    super('CurupiraOfflineDB');
    this.version(1).stores({
      municipios: 'codigo_ibge',
      focos: 'id, codigo_ibge, registado_em',
      previsoes: 'id, codigo_ibge, data_referencia',
      outboxCampo: '++local_id, codigo_ibge, registado_em',
    });
  }
}

export const offlineDB = new CurupiraOfflineDB();
