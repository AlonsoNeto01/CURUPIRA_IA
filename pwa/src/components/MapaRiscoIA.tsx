import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LocateFixed, Maximize2, Layers } from 'lucide-react';
import type { MunicipioIBGE, ZonaRiscoEspacial } from '../lib/supabase';
import {
  aplicarModoBasemap,
  criarEstiloMapaBase,
  obterSedeMunicipio,
  type BasemapMode,
} from '../lib/mapConfig';

interface Props {
  municipio: MunicipioIBGE | null;
  zonas: ZonaRiscoEspacial[];
  zonaSelecionada: ZonaRiscoEspacial | null;
  onSelectZona: (zona: ZonaRiscoEspacial) => void;
}

export function MapaRiscoIA({ municipio, zonas, zonaSelecionada, onSelectZona }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sedeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const zonasRef = useRef<ZonaRiscoEspacial[]>(zonas);
  zonasRef.current = zonas;
  const [basemap, setBasemap] = useState<BasemapMode>('hibrido');

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: criarEstiloMapaBase(),
      center: [-55.8661, -1.7656],
      zoom: 7.5,
      maxZoom: 17,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      const beforeLabels = map.getLayer('base-rotulos') ? 'base-rotulos' : undefined;

      map.addSource('zonas-risco-ia', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer(
        {
          id: 'zonas-fill',
          type: 'fill',
          source: 'zonas-risco-ia',
          paint: {
            'fill-color': [
              'interpolate',
              ['linear'],
              ['get', 'score_risco'],
              35, '#eab308',   // Moderado (Amarelo)
              58, '#f97316',   // Alto (Laranja)
              78, '#ef4444',   // Crítico (Vermelho)
              90, '#991b1b',   // Crítico Severo (Vermelho escuro)
              97, '#450a0a',   // Epicentro (Vinho escuro)
            ],
            'fill-opacity': [
              'case',
              ['==', ['get', 'selecionado'], true],
              0.82,
              0.55,
            ],
          },
        },
        beforeLabels
      );

      map.addLayer(
        {
          id: 'zonas-line',
          type: 'line',
          source: 'zonas-risco-ia',
          paint: {
            'line-color': [
              'case',
              ['==', ['get', 'selecionado'], true],
              '#38bdf8',
              'rgba(255,255,255,0.75)',
            ],
            'line-width': [
              'case',
              ['==', ['get', 'selecionado'], true],
              3.2,
              0.9,
            ],
            'line-opacity': 0.9,
          },
        },
        beforeLabels
      );

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
      sedeMarkerRef.current?.remove();
      sedeMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) aplicarModoBasemap(map, basemap);
    else map.once('load', () => aplicarModoBasemap(map, basemap));
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !municipio) return;

    if (municipio.bbox_w) {
      map.fitBounds(
        [
          [municipio.bbox_w, municipio.bbox_s],
          [municipio.bbox_e, municipio.bbox_n],
        ],
        { padding: 30, duration: 750 }
      );
    }

    sedeMarkerRef.current?.remove();
    const sede = obterSedeMunicipio(municipio);
    if (sede) {
      const el = document.createElement('div');
      el.className = 'sede-pin';
      el.innerHTML = `<span class="sede-dot"></span><span>Sede: ${sede.nome}</span>`;
      el.title = `Clique para aproximar na sede urbana de ${sede.nome}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        map.flyTo({ center: sede.coords, zoom: 12, duration: 850 });
      };
      sedeMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(sede.coords)
        .addTo(map);
    }
  }, [municipio?.codigo_ibge]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !zonaSelecionada) return;
    map.flyTo({
      center: [zonaSelecionada.centro_lon, zonaSelecionada.centro_lat],
      zoom: Math.max(map.getZoom(), 10.2),
      duration: 700,
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

  function irParaSede() {
    const map = mapRef.current;
    const sede = obterSedeMunicipio(municipio);
    if (!map || !sede) return;
    map.flyTo({ center: sede.coords, zoom: 11.8, duration: 850 });
  }

  function verMunicipioTodo() {
    const map = mapRef.current;
    if (!map || !municipio?.bbox_w) return;
    map.fitBounds(
      [
        [municipio.bbox_w, municipio.bbox_s],
        [municipio.bbox_e, municipio.bbox_n],
      ],
      { padding: 30, duration: 750 }
    );
  }

  return (
    <div className="map-wrapper">
      <div ref={containerRef} className="map-frame" />

      <div className="map-toolbar">
        <div className="map-basemap-select">
          <Layers size={13} />
          <select
            value={basemap}
            onChange={(e) => setBasemap(e.target.value as BasemapMode)}
            aria-label="Selecionar camada base do mapa"
          >
            <option value="hibrido">Satélite Híbrido</option>
            <option value="urbano">Mapa Urbano / Vias</option>
            <option value="escuro">Escuro Tático</option>
          </select>
        </div>

        <button type="button" className="map-tool-btn" onClick={irParaSede} title="Centralizar na sede urbana">
          <LocateFixed size={13} /> Ir para Sede
        </button>

        <button type="button" className="map-tool-btn" onClick={verMunicipioTodo} title="Enquadrar município inteiro">
          <Maximize2 size={13} /> Município Todo
        </button>
      </div>

      <div className="map-floating-legend gradient-mode">
        <div className="grad-bar" />
        <div className="grad-labels">
          <span>35 Mod.</span>
          <span>58 Alto</span>
          <span>78 Crít.</span>
          <span>90+ Epicentro</span>
        </div>
      </div>
    </div>
  );
}
