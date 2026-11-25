import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { FocoIncendio, MunicipioIBGE } from '../lib/supabase';

interface Props {
  municipio: MunicipioIBGE | null;
  focos: FocoIncendio[];
  perimetros: FeatureCollection<Polygon | MultiPolygon>;
  onSelectCoord?: (lat: number, lon: number) => void;
}

export function MapaTatico({ municipio, focos, perimetros, onSelectCoord }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          satelite: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            ],
            tileSize: 256,
            attribution: 'Esri World Imagery | Curupira IA',
          },
        },
        layers: [{ id: 'satelite-base', type: 'raster', source: 'satelite' }],
      },
      center: [-55.86, -1.76],
      zoom: 7,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('perimetros-dbscan', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'perimetros-fill',
        type: 'fill',
        source: 'perimetros-dbscan',
        paint: {
          'fill-color': [
            'match',
            ['get', 'severidade'],
            'CRÍTICA', '#ef4444',
            'ALTA', '#f97316',
            '#eab308',
          ],
          'fill-opacity': 0.35,
        },
      });
      map.addLayer({
        id: 'perimetros-line',
        type: 'line',
        source: 'perimetros-dbscan',
        paint: {
          'line-color': [
            'match',
            ['get', 'severidade'],
            'CRÍTICA', '#b91c1c',
            'ALTA', '#ea580c',
            '#ca8a04',
          ],
          'line-width': 2,
        },
      });

      map.addSource('focos-pontos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'focos-circle',
        type: 'circle',
        source: 'focos-pontos',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'origem'], 'CAMPO_BRIGADA'], 7, 4.5],
          'circle-color': ['case', ['==', ['get', 'origem'], 'CAMPO_BRIGADA'], '#38bdf8', '#fb923c'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    });

    map.on('click', (e) => {
      if (onSelectCoord) {
        onSelectCoord(Number(e.lngLat.lat.toFixed(5)), Number(e.lngLat.lng.toFixed(5)));
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Centraliza no município selecionado
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !municipio || !municipio.bbox_w) return;
    map.fitBounds(
      [
        [municipio.bbox_w, municipio.bbox_s],
        [municipio.bbox_e, municipio.bbox_n],
      ],
      { padding: 28, duration: 800 }
    );
  }, [municipio?.codigo_ibge]);

  // Atualiza fontes GeoJSON ao mudar focos/perímetros
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const atualizar = () => {
      const srcPerim = map.getSource('perimetros-dbscan') as maplibregl.GeoJSONSource | undefined;
      const srcPts = map.getSource('focos-pontos') as maplibregl.GeoJSONSource | undefined;
      if (srcPerim) srcPerim.setData(perimetros);
      if (srcPts) {
        srcPts.setData({
          type: 'FeatureCollection',
          features: focos.map((f) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
            properties: {
              id: f.id,
              origem: f.origem,
              frp_mw: f.frp_mw,
              satelite: f.satelite,
            },
          })),
        });
      }
    };

    if (map.isStyleLoaded()) atualizar();
    else map.once('load', atualizar);
  }, [focos, perimetros]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '420px', borderRadius: '12px', overflow: 'hidden', border: '1px solid #334155' }}
    />
  );
}
