import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import type { FocoIncendio } from './supabase';

export interface FrenteCombate {
  clusterId: number;
  severidade: 'CRÍTICA' | 'ALTA' | 'MODERADA';
  totalFocos: number;
  frpTotalMw: number;
  areaHectares: number;
  centroLat: number;
  centroLon: number;
  jurisdicoes: string[];
  perimetro: Feature<Polygon | MultiPolygon>;
}

/** Converte grau decimal para Graus, Minutos e Segundos (padrão rádio/Garmin). */
export function paraGMS(valor: number, tipo: 'lat' | 'lon'): string {
  const dir = tipo === 'lat' ? (valor >= 0 ? 'N' : 'S') : valor >= 0 ? 'E' : 'W';
  const abs = Math.abs(valor);
  const g = Math.floor(abs);
  const minFloat = (abs - g) * 60;
  const m = Math.floor(minFloat);
  const s = ((minFloat - m) * 60).toFixed(1);
  return `${g}°${String(m).padStart(2, '0')}'${s}" ${dir}`;
}

/** Calcula distância (km) e azimute (0°–360°) entre posição do brigadista e alvo. */
export function calcularNavegacao(
  origemLat: number,
  origemLon: number,
  alvoLat: number,
  alvoLon: number
): { distanciaKm: number; azimute: number; rumoCardeal: string } {
  const p1 = turf.point([origemLon, origemLat]);
  const p2 = turf.point([alvoLon, alvoLat]);
  const distanciaKm = turf.distance(p1, p2, { units: 'kilometers' });
  const azBruto = turf.bearing(p1, p2);
  const azimute = (azBruto + 360) % 360;
  const pontos = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
  const rumoCardeal = pontos[Math.round(azimute / 45) % 8];
  return { distanciaKm, azimute, rumoCardeal };
}

/**
 * Delineia frentes ativas de combate 100% offline:
 * 1) Clusterização DBSCAN (ε = 4.5 km, MinPts = 1)
 * 2) Buffer geodésico (r = 1.8 km) + união morfológica turf.union (API Turf v7)
 * 3) Integração de área (ha) e FRP acumulado (MW)
 */
export function gerarFrentesDBSCAN(focos: FocoIncendio[]): {
  frentes: FrenteCombate[];
  perimetrosGeoJSON: FeatureCollection<Polygon | MultiPolygon>;
} {
  if (!focos.length) {
    return { frentes: [], perimetrosGeoJSON: turf.featureCollection([]) };
  }

  const pts = turf.featureCollection<Point, { idx: number }>(
    focos.map((f, idx) => turf.point([f.lon, f.lat], { idx }))
  );

  const clustered = turf.clustersDbscan(pts, 4.5, { minPoints: 1, units: 'kilometers' });

  const grupos = new Map<number, FocoIncendio[]>();
  clustered.features.forEach((feat, i) => {
    const cid = typeof feat.properties?.cluster === 'number' ? feat.properties.cluster : 10000 + i;
    const arr = grupos.get(cid) || [];
    arr.push(focos[feat.properties.idx]);
    grupos.set(cid, arr);
  });

  const frentes: FrenteCombate[] = [];
  const perimetros: Feature<Polygon | MultiPolygon>[] = [];

  let seq = 1;
  for (const lista of grupos.values()) {
    const buffers: Feature<Polygon | MultiPolygon>[] = [];
    for (const f of lista) {
      const b = turf.buffer(turf.point([f.lon, f.lat]), 1.8, { units: 'kilometers', steps: 20 });
      if (b) buffers.push(b as Feature<Polygon | MultiPolygon>);
    }
    if (!buffers.length) continue;

    let uniao: Feature<Polygon | MultiPolygon> = buffers[0];
    if (buffers.length > 1) {
      const merged = turf.union(turf.featureCollection(buffers));
      if (merged) uniao = merged as Feature<Polygon | MultiPolygon>;
    }

    const frpTotalMw = lista.reduce((acc, f) => acc + (Number(f.frp_mw) || 0), 0);
    const areaHectares = turf.area(uniao) / 10000;
    const centro = turf.centroid(uniao).geometry.coordinates;
    const jurisdicoes = Array.from(
      new Set(
        lista
          .filter((f) => f.jurisdicao_tipo && f.jurisdicao_nome)
          .map((f) => `${f.jurisdicao_tipo}: ${f.jurisdicao_nome}`)
      )
    );

    const severidade: FrenteCombate['severidade'] =
      frpTotalMw >= 150 || lista.length >= 10
        ? 'CRÍTICA'
        : frpTotalMw >= 40 || lista.length >= 4
        ? 'ALTA'
        : 'MODERADA';

    uniao.properties = {
      clusterId: seq,
      severidade,
      totalFocos: lista.length,
      frpTotalMw: Number(frpTotalMw.toFixed(1)),
      areaHectares: Number(areaHectares.toFixed(0)),
    };

    frentes.push({
      clusterId: seq,
      severidade,
      totalFocos: lista.length,
      frpTotalMw: Number(frpTotalMw.toFixed(1)),
      areaHectares: Number(areaHectares.toFixed(0)),
      centroLat: centro[1],
      centroLon: centro[0],
      jurisdicoes,
      perimetro: uniao,
    });
    perimetros.push(uniao);
    seq++;
  }

  frentes.sort((a, b) => b.frpTotalMw - a.frpTotalMw);
  return { frentes, perimetrosGeoJSON: turf.featureCollection(perimetros) };
}
