import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { LocateFixed, Maximize2, Layers } from 'lucide-react';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type { FocoIncendio, MunicipioIBGE } from '../lib/supabase';
import type { FrenteCombate } from '../lib/geoprocessing';
import {
  aplicarModoBasemap,
  criarEstiloMapaBase,
  obterSedeMunicipio,
  type BasemapMode,
} from '../lib/mapConfig';

interface Props {
  municipio: MunicipioIBGE | null;
  focos: FocoIncendio[];
  perimetros: FeatureCollection<Polygon | MultiPolygon>;
  frenteSelecionada: FrenteCombate | null;
  onSelectFrente?: (clusterId: number) => void;
  onSelectCoord?: (lat: number, lon: number) => void;
}

export function MapaTatico({
  municipio,
  focos,
  perimetros,
  frenteSelecionada,
  onSelectFrente,
  onSelectCoord,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sedeMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode>('hibrido');

  const onSelectCoordRef = useRef(onSelectCoord);
  onSelectCoordRef.current = onSelectCoord;
  const onSelectFrenteRef = useRef(onSelectFrente);
  onSelectFrenteRef.current = onSelectFrente;

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
      // Insere perímetros abaixo da camada de rótulos para manter nomes de cidades/rios legíveis
      const beforeLabels = map.getLayer('base-rotulos') ? 'base-rotulos' : undefined;

      map.addSource('perimetros-dbscan', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer(
        {
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
            'fill-opacity': [
              'case',
              ['==', ['get', 'selecionado'], true],
              0.52,
              0.32,
            ],
          },
        },
        beforeLabels
      );
      map.addLayer(
        {
          id: 'perimetros-line',
          type: 'line',
          source: 'perimetros-dbscan',
          paint: {
            'line-color': [
              'case',
              ['==', ['get', 'selecionado'], true],
              '#38bdf8',
              [
                'match',
                ['get', 'severidade'],
                'CRÍTICA', '#ef4444',
                'ALTA', '#f97316',
                '#eab308',
              ],
            ],
            'line-width': [
              'case',
              ['==', ['get', 'selecionado'], true],
              3.5,
              2,
            ],
          },
        },
        beforeLabels
      );

      map.addSource('focos-pontos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'focos-circle',
        type: 'circle',
        source: 'focos-pontos',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6, ['case', ['==', ['get', 'origem'], 'CAMPO_BRIGADA'], 6, 3.5],
            12, ['case', ['==', ['get', 'origem'], 'CAMPO_BRIGADA'], 9, 6.5],
          ],
          'circle-color': ['case', ['==', ['get', 'origem'], 'CAMPO_BRIGADA'], '#38bdf8', '#fb923c'],
          'circle-stroke-width': 1.4,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.on('click', 'perimetros-fill', (e) => {
        const cid = e.features?.[0]?.properties?.clusterId;
        if (typeof cid === 'number' && onSelectFrenteRef.current) {
          onSelectFrenteRef.current(cid);
        }
      });

      map.on('mouseenter', 'perimetros-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'perimetros-fill', () => {
        map.getCanvas().style.cursor = '';
      });
    });

    map.on('click', (e) => {
      if (onSelectCoordRef.current) {
        onSelectCoordRef.current(Number(e.lngLat.lat.toFixed(5)), Number(e.lngLat.lng.toFixed(5)));
      }
    });

    mapRef.current = map;
    return () => {
      sedeMarkerRef.current?.remove();
      sedeMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Alterna camada base sem destruir camadas GeoJSON
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) aplicarModoBasemap(map, basemap);
    else map.once('load', () => aplicarModoBasemap(map, basemap));
  }, [basemap]);

  // Centraliza no município selecionado + posiciona marcador da Sede Municipal
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !municipio) return;

    if (municipio.bbox_w) {
      map.fitBounds(
        [
          [municipio.bbox_w, municipio.bbox_s],
          [municipio.bbox_e, municipio.bbox_n],
        ],
        { padding: 32, duration: 800 }
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

  // Voa suavemente até a frente selecionada na lista lateral
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !frenteSelecionada) return;
    map.flyTo({
      center: [frenteSelecionada.centroLon, frenteSelecionada.centroLat],
      zoom: Math.max(map.getZoom(), 10.6),
      duration: 750,
    });
  }, [frenteSelecionada?.clusterId]);

  // Atualiza fontes GeoJSON ao mudar focos/perímetros/seleção
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const atualizar = () => {
      const srcPerim = map.getSource('perimetros-dbscan') as maplibregl.GeoJSONSource | undefined;
      const srcPts = map.getSource('focos-pontos') as maplibregl.GeoJSONSource | undefined;
      if (srcPerim) {
        srcPerim.setData({
          type: 'FeatureCollection',
          features: perimetros.features.map((feat) => ({
            ...feat,
            properties: {
              ...feat.properties,
              selecionado: feat.properties?.clusterId === frenteSelecionada?.clusterId,
            },
          })),
        });
      }
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
  }, [focos, perimetros, frenteSelecionada?.clusterId]);

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
      { padding: 32, duration: 800 }
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

      <div className="map-floating-legend">
        <span><i className="dot" style={{ background: '#fb923c' }} /> Foco Satélite</span>
        <span><i className="dot" style={{ background: '#38bdf8' }} /> Brigada</span>
        <span><i className="sq" style={{ background: '#ef4444' }} /> Crítica</span>
        <span><i className="sq" style={{ background: '#f97316' }} /> Alta</span>
        <span><i className="sq" style={{ background: '#eab308' }} /> Moderada</span>
      </div>
    </div>
  );
}
