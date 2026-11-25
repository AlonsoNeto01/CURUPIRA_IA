import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MunicipioIBGE, ZonaRiscoEspacial } from '../lib/supabase';

interface Props {
  municipio: MunicipioIBGE | null;
  zonas: ZonaRiscoEspacial[];
  zonaSelecionada: ZonaRiscoEspacial | null;
  onSelectZona: (zona: ZonaRiscoEspacial) => void;
}

export function MapaRiscoIA({ municipio, zonas, zonaSelecionada, onSelectZona }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const zonasRef = useRef<ZonaRiscoEspacial[]>(zonas);
  zonasRef.current = zonas;

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
      map.addSource('zonas-risco-ia', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'zonas-fill',
        type: 'fill',
        source: 'zonas-risco-ia',
        paint: {
          'fill-color': [
            'interpolate',
            ['linear'],
            ['get', 'score_risco'],
            35, '#eab308',
            55, '#f97316',
            75, '#ef4444',
            90, '#7f1d1d',
          ],
          'fill-opacity': [
            'case',
            ['==', ['get', 'selecionado'], true],
            0.82,
            0.58,
          ],
        },
      });

      map.addLayer({
        id: 'zonas-line',
        type: 'line',
        source: 'zonas-risco-ia',
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'selecionado'], true],
            '#38bdf8',
            '#ffffff',
          ],
          'line-width': [
            'case',
            ['==', ['get', 'selecionado'], true],
            3,
            0.9,
          ],
          'line-opacity': 0.85,
        },
      });

      map.on('click', 'zonas-fill', (e) => {
        const hexId = e.features?.[0]?.properties?.hex_id;
        const achada = zonasRef.current.find((z) => z.hex_id === hexId);
        if (achada) onSelectZona(achada);
      });

      map.on('mouseenter', 'zonas-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'zonas-fill', () => {
        map.getCanvas().style.cursor = '';
      });
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !municipio || !municipio.bbox_w) return;
    map.fitBounds(
      [
        [municipio.bbox_w, municipio.bbox_s],
        [municipio.bbox_e, municipio.bbox_n],
      ],
      { padding: 26, duration: 700 }
    );
  }, [municipio?.codigo_ibge]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !zonaSelecionada) return;
    map.easeTo({
      center: [zonaSelecionada.centro_lon, zonaSelecionada.centro_lat],
      zoom: Math.max(map.getZoom(), 9.2),
      duration: 600,
    });
  }, [zonaSelecionada?.hex_id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const atualizar = () => {
      const src = map.getSource('zonas-risco-ia') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: 'FeatureCollection',
        features: zonas.map((z) => ({
          type: 'Feature',
          geometry: z.geojson,
          properties: {
            hex_id: z.hex_id,
            nivel_risco: z.nivel_risco,
            score_risco: z.score_risco,
            selecionado: zonaSelecionada?.hex_id === z.hex_id,
          },
        })),
      });
    };

    if (map.isStyleLoaded()) atualizar();
    else map.once('load', atualizar);
  }, [zonas, zonaSelecionada?.hex_id]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '420px', borderRadius: '12px', overflow: 'hidden', border: '1px solid #334155' }}
    />
  );
}
