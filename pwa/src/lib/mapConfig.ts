import type maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import type { MunicipioIBGE } from './supabase';

export type BasemapMode = 'hibrido' | 'urbano' | 'escuro';

export const SEDES_MUNICIPIOS: Record<string, { nome: string; coords: [number, number] }> = {
  '1505304': { nome: 'Oriximiná', coords: [-55.8661, -1.7656] },
  '1505106': { nome: 'Óbidos', coords: [-55.5186, -1.9022] },
  '1506807': { nome: 'Santarém', coords: [-54.7083, -2.4431] },
  '1505502': { nome: 'Paragominas', coords: [-47.3522, -2.9956] },
  '1500602': { nome: 'Altamira', coords: [-52.2064, -3.2033] },
};

export function obterSedeMunicipio(mun: MunicipioIBGE | null): { nome: string; coords: [number, number] } | null {
  if (!mun) return null;
  if (SEDES_MUNICIPIOS[mun.codigo_ibge]) {
    return SEDES_MUNICIPIOS[mun.codigo_ibge];
  }
  if (mun.bbox_w && mun.bbox_e && mun.bbox_s && mun.bbox_n) {
    return {
      nome: mun.nome,
      coords: [(mun.bbox_w + mun.bbox_e) / 2, (mun.bbox_s + mun.bbox_n) / 2],
    };
  }
  return null;
}

/**
 * Estilo base multi-camada com maxzoom: 14 nas fontes Esri para habilitar
 * overzoom suave até o nível 17 (elimina o bloco cinza "Map data not yet available").
 */
export function criarEstiloMapaBase(): StyleSpecification {
  return {
    version: 8,
    sources: {
      'esri-satelite': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 14,
        attribution: 'Esri World Imagery | Curupira IA',
      },
      'esri-estradas': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 14,
      },
      'esri-rotulos': {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 14,
      },
      'carto-voyager': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
          'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution: '© OpenStreetMap, © CARTO',
      },
      'carto-dark': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution: '© OpenStreetMap, © CARTO',
      },
    },
    layers: [
      {
        id: 'base-satelite',
        type: 'raster',
        source: 'esri-satelite',
        layout: { visibility: 'visible' },
      },
      {
        id: 'base-urbano',
        type: 'raster',
        source: 'carto-voyager',
        layout: { visibility: 'none' },
      },
      {
        id: 'base-escuro',
        type: 'raster',
        source: 'carto-dark',
        layout: { visibility: 'none' },
      },
      {
        id: 'base-estradas',
        type: 'raster',
        source: 'esri-estradas',
        paint: { 'raster-opacity': 0.75 },
        layout: { visibility: 'visible' },
      },
      {
        id: 'base-rotulos',
        type: 'raster',
        source: 'esri-rotulos',
        paint: { 'raster-opacity': 0.95 },
        layout: { visibility: 'visible' },
      },
    ],
  };
}

export function aplicarModoBasemap(map: maplibregl.Map, modo: BasemapMode): void {
  const vis = (cond: boolean) => (cond ? 'visible' : 'none');
  const set = (id: string, cond: boolean) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', vis(cond));
    }
  };
  set('base-satelite', modo === 'hibrido');
  set('base-estradas', modo === 'hibrido');
  set('base-rotulos', modo === 'hibrido');
  set('base-urbano', modo === 'urbano');
  set('base-escuro', modo === 'escuro');
}
