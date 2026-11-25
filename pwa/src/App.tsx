import { useEffect, useMemo, useState } from 'react';
import {
  Flame, BrainCircuit, Wifi, WifiOff, Compass, MapPin, ShieldAlert,
  LogOut, RefreshCw, PlusCircle, Send, FileText, Activity, ChevronDown, ChevronUp, Zap, Layers, AlertTriangle
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, Legend
} from 'recharts';
import {
  supabase, type FocoIncendio, type MunicipioIBGE, type PerfilUsuario, type PrevisaoIA, type SerieDiariaItem, type ZonaRiscoEspacial
} from './lib/supabase';
import { offlineDB } from './lib/db';
import { calcularNavegacao, gerarFrentesDBSCAN, paraGMS, type FrenteCombate } from './lib/geoprocessing';
import { emitirBoletimOficialPDF } from './lib/boletimPdf';
import { MapaTatico } from './components/MapaTatico';
import { MapaRiscoIA } from './components/MapaRiscoIA';

const COR_RISCO: Record<string, string> = {
  BAIXO: '#22c55e',
  MODERADO: '#eab308',
  ALTO: '#f97316',
  'CRÍTICO': '#ef4444',
};

const TABELA_4FOLDS = [
  { fold: 'Fold 1 (2022)', regime: 'Pico Extremo (255)', maeNaive: '6,694', maeCurupira: '4,923', r2: '0,236', f1: '0,671', picp: '97,2%' },
  { fold: 'Fold 2 (2023)', regime: 'Super El Niño', maeNaive: '8,970', maeCurupira: '7,093', r2: '0,419', f1: '0,880', picp: '96,7%' },
  { fold: 'Fold 3 (2024)', regime: 'Seca Severa', maeNaive: '6,792', maeCurupira: '5,738', r2: '0,425', f1: '0,761', picp: '96,4%' },
  { fold: 'Fold 4 (2025)', regime: 'Operacional', maeNaive: '4,717', maeCurupira: '3,787', r2: '0,472', f1: '0,715', picp: '96,5%' },
];

function somarDiasISO(dataISO: string, dias: number): string {
  const dt = new Date(`${dataISO}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(5, 10);
}

function fmtIC95(inf: number, sup: number): string {
  return sup > 500
    ? `${inf.toFixed(1)} – >500 (extremo: ${sup.toFixed(0)})`
    : `${inf.toFixed(1)} – ${sup.toFixed(1)}`;
}

function interpretarBiofisica(prev: PrevisaoIA) {
  const vpd = Number(prev.vpd_kpa);
  const nest = Number(prev.indice_nesterov);
  const ang = Number(prev.indice_angstrom);
  const solo = Number(prev.umidade_solo_pct);

  return {
    vpd:
      vpd >= 2.0
        ? { txt: 'Ar muito seco', tom: 'crit' }
        : vpd >= 1.5
        ? { txt: 'Estresse moderado', tom: 'warn' }
        : { txt: 'Normal', tom: 'ok' },
    nesterov:
      nest >= 4000
        ? { txt: 'Vegetação inflamável', tom: 'crit' }
        : nest >= 1000
        ? { txt: 'Atenção à serrapilheira', tom: 'warn' }
        : { txt: 'Baixa inflamabilidade', tom: 'ok' },
    angstrom:
      ang < 2.5
        ? { txt: 'Ignição facilitada', tom: 'crit' }
        : ang < 3.0
        ? { txt: 'Atenção moderada', tom: 'warn' }
        : { txt: 'Propagação desfavorável', tom: 'ok' },
    solo:
      solo < 25
        ? { txt: 'Solo ressecado', tom: 'warn' }
        : solo < 32
        ? { txt: 'Umidade intermediária', tom: 'neutral' }
        : { txt: 'Solo úmido', tom: 'ok' },
  };
}

export default function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authErro, setAuthErro] = useState('');
  const [perfil, setPerfil] = useState<PerfilUsuario | null>(null);
  const [carregandoAuth, setCarregandoAuth] = useState(true);

  const [online, setOnline] = useState(navigator.onLine);
  const [aba, setAba] = useState<'real' | 'ia'>('real');
  const [janelaHoras, setJanelaHoras] = useState<24 | 48 | 168>(48);
  const [filtroFrente, setFiltroFrente] = useState<'TODAS' | 'CRÍTICA' | 'ALTA'>('TODAS');
  const [municipios, setMunicipios] = useState<MunicipioIBGE[]>([]);
  const [ibgeAtivo, setIbgeAtivo] = useState('1505304');

  const [focos, setFocos] = useState<FocoIncendio[]>([]);
  const [previsoes, setPrevisoes] = useState<PrevisaoIA[]>([]);
  const [serieDiaria, setSerieDiaria] = useState<SerieDiariaItem[]>([]);
  const [zonasRisco, setZonasRisco] = useState<ZonaRiscoEspacial[]>([]);
  const [zonaAlvo, setZonaAlvo] = useState<ZonaRiscoEspacial | null>(null);
  const [pendentesOutbox, setPendentesOutbox] = useState(0);
  const [gerandoPdf, setGerandoPdf] = useState(false);

  // GPS e Bússola Azimutal
  const [gps, setGps] = useState<{ lat: number; lon: number } | null>(null);
  const [frenteAlvo, setFrenteAlvo] = useState<FrenteCombate | null>(null);

  // Formulário CAMPO_BRIGADA (recolhível para liberar espaço à lista de frentes)
  const [formAberto, setFormAberto] = useState(false);
  const [avisoCoordMapa, setAvisoCoordMapa] = useState(false);
  const [formLat, setFormLat] = useState('');
  const [formLon, setFormLon] = useState('');
  const [formRef, setFormRef] = useState('');
  const [formPorte, setFormPorte] = useState('Médio');
  const [formObs, setFormObs] = useState('');
  const [msgCampo, setMsgCampo] = useState('');

  useEffect(() => {
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session?.user) {
        await carregarPerfil(data.session.user.id);
      }
      setCarregandoAuth(false);
    });
  }, []);

  async function carregarPerfil(userId: string) {
    const { data } = await supabase
      .from('perfis_usuario')
      .select('user_id, codigo_ibge, nome_completo, cargo, role')
      .eq('user_id', userId)
      .single();
    if (data) {
      setPerfil(data as PerfilUsuario);
      setIbgeAtivo(data.codigo_ibge);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthErro('');
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthErro('E-mail ou senha inválidos.');
      return;
    }
    if (data.user) await carregarPerfil(data.user.id);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setPerfil(null);
  }

  useEffect(() => {
    if (!perfil) return;
    (async () => {
      if (online) {
        const { data } = await supabase
          .from('municipios_ibge')
          .select('codigo_ibge, nome, uf, bbox_w, bbox_s, bbox_e, bbox_n, pontos_grade')
          .eq('ativo', true)
          .order('nome');
        if (data?.length) {
          setMunicipios(data as MunicipioIBGE[]);
          await offlineDB.municipios.bulkPut(data as MunicipioIBGE[]);
          return;
        }
      }
      setMunicipios(await offlineDB.municipios.toArray());
    })();
  }, [perfil, online]);

  async function sincronizarDadosMunicipio() {
    if (!perfil || !ibgeAtivo) return;
    const corteISO = new Date(Date.now() - janelaHoras * 3600000).toISOString();

    if (online) {
      const fila = await offlineDB.outboxCampo.toArray();
      for (const item of fila) {
        const { error } = await supabase.from('focos_incendio').insert({
          codigo_ibge: item.codigo_ibge,
          municipio: item.municipio,
          lat: item.lat,
          lon: item.lon,
          satelite: 'CAMPO_BRIGADA',
          confianca: 'ALTA',
          origem: 'CAMPO_BRIGADA',
          local_referencia: item.local_referencia,
          porte: item.porte,
          observacoes: item.observacoes,
          criado_por: perfil.user_id,
          registado_em: item.registado_em,
        });
        if (!error && item.local_id) {
          await offlineDB.outboxCampo.delete(item.local_id);
        }
      }

      const [resFocos, resPrev, resSerie, resZonas] = await Promise.all([
        supabase
          .from('focos_incendio')
          .select('*')
          .eq('codigo_ibge', ibgeAtivo)
          .gte('registado_em', corteISO)
          .order('registado_em', { ascending: false })
          .limit(2000),
        supabase
          .from('previsoes_ia')
          .select('*')
          .eq('codigo_ibge', ibgeAtivo)
          .order('data_referencia', { ascending: false })
          .limit(15),
        supabase
          .from('serie_diaria_municipio')
          .select('id, codigo_ibge, data, total_focos_snpp, frp_total_snpp, nesterov_raw, dry_spell')
          .eq('codigo_ibge', ibgeAtivo)
          .order('data', { ascending: false })
          .limit(14),
        supabase
          .from('risco_espacial_72h')
          .select('*')
          .eq('codigo_ibge', ibgeAtivo)
          .order('data_referencia', { ascending: false })
          .order('score_risco', { ascending: false })
          .limit(80),
      ]);

      if (resFocos.data) {
        setFocos(resFocos.data as FocoIncendio[]);
        await offlineDB.focos.where('codigo_ibge').equals(ibgeAtivo).delete();
        await offlineDB.focos.bulkPut(resFocos.data as FocoIncendio[]);
      }
      if (resPrev.data) {
        setPrevisoes(resPrev.data as PrevisaoIA[]);
        await offlineDB.previsoes.where('codigo_ibge').equals(ibgeAtivo).delete();
        await offlineDB.previsoes.bulkPut(resPrev.data as PrevisaoIA[]);
      }
      if (resSerie.data) {
        const ordenada = [...(resSerie.data as SerieDiariaItem[])].reverse();
        setSerieDiaria(ordenada);
        await offlineDB.serieDiaria.where('codigo_ibge').equals(ibgeAtivo).delete();
        await offlineDB.serieDiaria.bulkPut(ordenada);
      }
      if (resZonas.data) {
        const maisRecente = resZonas.data[0]?.data_referencia;
        const doDia = maisRecente
          ? (resZonas.data as ZonaRiscoEspacial[]).filter((z) => z.data_referencia === maisRecente)
          : [];
        setZonasRisco(doDia);
        await offlineDB.zonasRisco.where('codigo_ibge').equals(ibgeAtivo).delete();
        if (doDia.length) await offlineDB.zonasRisco.bulkPut(doDia);
      }
    } else {
      const [fLoc, pLoc, sLoc, zLoc] = await Promise.all([
        offlineDB.focos.where('codigo_ibge').equals(ibgeAtivo).toArray(),
        offlineDB.previsoes.where('codigo_ibge').equals(ibgeAtivo).toArray(),
        offlineDB.serieDiaria.where('codigo_ibge').equals(ibgeAtivo).toArray(),
        offlineDB.zonasRisco.where('codigo_ibge').equals(ibgeAtivo).toArray(),
      ]);
      setFocos(fLoc.filter((f) => f.registado_em >= corteISO));
      setPrevisoes(pLoc.sort((a, b) => b.data_referencia.localeCompare(a.data_referencia)));
      setSerieDiaria(sLoc.sort((a, b) => a.data.localeCompare(b.data)));
      setZonasRisco(zLoc.sort((a, b) => b.score_risco - a.score_risco));
    }
    setPendentesOutbox(await offlineDB.outboxCampo.count());
  }

  useEffect(() => {
    setFrenteAlvo(null);
    setZonaAlvo(null);
    sincronizarDadosMunicipio();
  }, [perfil, ibgeAtivo, janelaHoras, online]);

  useEffect(() => {
    if (!perfil || !online) return;
    const canal = supabase
      .channel(`curupira-${ibgeAtivo}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'focos_incendio', filter: `codigo_ibge=eq.${ibgeAtivo}` },
        () => sincronizarDadosMunicipio()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'previsoes_ia', filter: `codigo_ibge=eq.${ibgeAtivo}` },
        () => sincronizarDadosMunicipio()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(canal);
    };
  }, [perfil, ibgeAtivo, janelaHoras, online]);

  function capturarGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(5));
        const lon = Number(pos.coords.longitude.toFixed(5));
        setGps({ lat, lon });
        setFormLat(String(lat));
        setFormLon(String(lon));
        setFormAberto(true);
      },
      () => {
        setFormAberto(true);
        setMsgCampo('Não foi possível obter GPS. Clique no mapa ou digite a coordenada.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function handleCoordDoMapa(lat: number, lon: number) {
    setFormLat(String(lat));
    setFormLon(String(lon));
    setAvisoCoordMapa(true);
    window.setTimeout(() => setAvisoCoordMapa(false), 3500);
  }

  async function registrarOcorrenciaCampo(e: React.FormEvent) {
    e.preventDefault();
    const munObj = municipios.find((m) => m.codigo_ibge === ibgeAtivo);
    const lat = Number(formLat);
    const lon = Number(formLon);
    if (!munObj || Number.isNaN(lat) || Number.isNaN(lon)) {
      setMsgCampo('Informe latitude e longitude válidas.');
      return;
    }

    const registro = {
      codigo_ibge: ibgeAtivo,
      municipio: munObj.nome,
      lat,
      lon,
      local_referencia: formRef || 'Registro em campo',
      porte: formPorte,
      observacoes: formObs,
      registado_em: new Date().toISOString(),
    };

    if (online) {
      const { error } = await supabase.from('focos_incendio').insert({
        ...registro,
        satelite: 'CAMPO_BRIGADA',
        confianca: 'ALTA',
        origem: 'CAMPO_BRIGADA',
        criado_por: perfil?.user_id,
      });
      if (!error) {
        setMsgCampo('Ocorrência registrada em tempo real no PostGIS.');
        setFormRef('');
        setFormObs('');
        await sincronizarDadosMunicipio();
        return;
      }
    }

    await offlineDB.outboxCampo.add(registro);
    setPendentesOutbox(await offlineDB.outboxCampo.count());
    setMsgCampo('Salvo localmente (Modo Floresta). Será enviado automaticamente ao recuperar sinal.');
    setFormRef('');
    setFormObs('');
  }

  const municipioAtual = useMemo(
    () => municipios.find((m) => m.codigo_ibge === ibgeAtivo) || null,
    [municipios, ibgeAtivo]
  );

  const { frentes, perimetrosGeoJSON } = useMemo(() => gerarFrentesDBSCAN(focos), [focos]);

  const kpisMonitoramento = useMemo(() => {
    const criticas = frentes.filter((f) => f.severidade === 'CRÍTICA').length;
    const areaTotalHa = frentes.reduce((acc, f) => acc + f.areaHectares, 0);
    const frpTotalMw = focos.reduce((acc, f) => acc + (Number(f.frp_mw) || 0), 0);
    return { criticas, areaTotalHa, frpTotalMw };
  }, [focos, frentes]);

  const frentesFiltradas = useMemo(() => {
    if (filtroFrente === 'TODAS') return frentes;
    return frentes.filter((f) => f.severidade === filtroFrente);
  }, [frentes, filtroFrente]);

  const ultimaPrev = previsoes[0] || null;
  const tagsBio = useMemo(() => (ultimaPrev ? interpretarBiofisica(ultimaPrev) : null), [ultimaPrev]);

  const { dadosGraficoContinuo, dataDivisoria } = useMemo(() => {
    const pontos: Array<{
      label: string;
      observado?: number;
      previsto?: number;
      icSupVisual?: number;
      icSupReal?: number;
    }> = serieDiaria.map((s) => ({
      label: s.data.slice(5),
      observado: Number(s.total_focos_snpp),
    }));

    const ultimaDataObs = pontos.length ? pontos[pontos.length - 1].label : undefined;

    if (ultimaPrev) {
      const maxObs = Math.max(10, ...pontos.map((p) => p.observado || 0));
      const maxPrev = Math.max(
        Number(ultimaPrev.focos_previstos_d1),
        Number(ultimaPrev.focos_previstos_d2),
        Number(ultimaPrev.focos_previstos_d3)
      );
      const tetoVisual = Math.max(maxObs, maxPrev) * 3.5;

      if (pontos.length) {
        pontos[pontos.length - 1].previsto = pontos[pontos.length - 1].observado;
      }

      const horizontes = [
        { dia: 0, tag: 'D+1', val: Number(ultimaPrev.focos_previstos_d1), sup: Number(ultimaPrev.ic_sup_d1) },
        { dia: 1, tag: 'D+2', val: Number(ultimaPrev.focos_previstos_d2), sup: Number(ultimaPrev.ic_sup_d2) },
        { dia: 2, tag: 'D+3', val: Number(ultimaPrev.focos_previstos_d3), sup: Number(ultimaPrev.ic_sup_d3) },
      ];

      for (const h of horizontes) {
        pontos.push({
          label: `${somarDiasISO(ultimaPrev.data_referencia, h.dia)} (${h.tag})`,
          previsto: h.val,
          icSupVisual: Number(Math.min(h.sup, tetoVisual).toFixed(1)),
          icSupReal: h.sup,
        });
      }
    }

    return { dadosGraficoContinuo: pontos, dataDivisoria: ultimaDataObs };
  }, [serieDiaria, ultimaPrev]);

  async function handleEmitirPDF() {
    if (!municipioAtual || !perfil || !ultimaPrev) return;
    setGerandoPdf(true);
    try {
      await emitirBoletimOficialPDF({
        municipio: municipioAtual,
        perfil,
        previsao: ultimaPrev,
        frentes,
        janelaHoras,
        totalFocosJanela: focos.length,
        zonasRisco,
      });
    } finally {
      setGerandoPdf(false);
    }
  }

  if (carregandoAuth) {
    return <div className="center-screen">Carregando Sala de Situação Curupira IA...</div>;
  }

  if (!perfil) {
    return (
      <div className="center-screen">
        <form className="card login-card" onSubmit={handleLogin}>
          <div className="brand">
            <div className="brand-icon"><Flame size={24} color="#fb923c" /></div>
            <div>
              <h1>Curupira IA</h1>
              <small>Sala de Situação • Defesa Civil &amp; SEMMA</small>
            </div>
          </div>
          <p className="muted">Monitoramento Orbital e Previsão de Incêndios Florestais 72h no Pará</p>
          <input type="email" placeholder="E-mail institucional" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Senha" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {authErro && <p className="err">{authErro}</p>}
          <button type="submit" className="btn-primary">Entrar na Sala de Situação</button>
        </form>
      </div>
    );
  }

  const nav =
    gps && frenteAlvo
      ? calcularNavegacao(gps.lat, gps.lon, frenteAlvo.centroLat, frenteAlvo.centroLon)
      : null;

  const xai = ultimaPrev?.xai_fatores || {};
  const rotuloJanela = janelaHoras === 168 ? 'Últimos 7 dias' : `Últimas ${janelaHoras}h`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon"><Flame size={22} color="#fb923c" /></div>
          <div>
            <div className="brand-title-row">
              <strong>CURUPIRA IA</strong>
              <span className="gov-tag">SALA DE SITUAÇÃO</span>
            </div>
            <small>{perfil.nome_completo} • {perfil.cargo || perfil.role}</small>
          </div>
        </div>

        <div className="controls">
          <div className="mun-select-wrap">
            {municipios.length > 1 ? (
              <select value={ibgeAtivo} onChange={(e) => setIbgeAtivo(e.target.value)}>
                {municipios.map((m) => (
                  <option key={m.codigo_ibge} value={m.codigo_ibge}>
                    {m.nome} — {m.uf}
                  </option>
                ))}
              </select>
            ) : (
              <span className="pill">{municipioAtual?.nome || ibgeAtivo}</span>
            )}
          </div>

          <div className="status-actions">
            <span className={`pill ${online ? 'ok' : 'offline'}`}>
              {online ? <Wifi size={14} /> : <WifiOff size={14} />}
              {online ? 'Online' : 'Modo Floresta'}
            </span>

            {pendentesOutbox > 0 && <span className="pill warn">{pendentesOutbox} pendente(s)</span>}

            <button className="icon-btn" onClick={sincronizarDadosMunicipio} title="Sincronizar dados">
              <RefreshCw size={16} />
            </button>
            <button className="icon-btn" onClick={handleLogout} title="Encerrar sessão">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <button className={aba === 'real' ? 'active' : ''} onClick={() => setAba('real')}>
          <MapPin size={16} /> Monitoramento Real <span className="tab-count mono">{focos.length}</span>
        </button>
        <button className={aba === 'ia' ? 'active' : ''} onClick={() => setAba('ia')}>
          <BrainCircuit size={16} /> IA de Previsão 72h
        </button>
      </nav>

      {aba === 'real' ? (
        <>
          <section className="kpis-exec">
            <div className="card exec-kpi">
              <div className="exec-kpi-top">
                <span>Focos Detectados</span>
                <Flame size={16} color="#fb923c" />
              </div>
              <strong className="mono">{focos.length.toLocaleString('pt-BR')}</strong>
              <small className="muted">{rotuloJanela} (VIIRS 375 m + Brigada)</small>
            </div>

            <div className="card exec-kpi">
              <div className="exec-kpi-top">
                <span>Frentes Ativas (DBSCAN)</span>
                <Layers size={16} color="#38bdf8" />
              </div>
              <strong className="mono">{frentes.length}</strong>
              <small className={kpisMonitoramento.criticas > 0 ? 'tag-inline crit' : 'muted'}>
                {kpisMonitoramento.criticas} frente(s) de severidade crítica
              </small>
            </div>

            <div className="card exec-kpi">
              <div className="exec-kpi-top">
                <span>Área Sob Alerta</span>
                <AlertTriangle size={16} color="#eab308" />
              </div>
              <strong className="mono">{kpisMonitoramento.areaTotalHa.toLocaleString('pt-BR')} ha</strong>
              <small className="muted">Perímetros táticos (buffer 1,8 km)</small>
            </div>

            <div className="card exec-kpi">
              <div className="exec-kpi-top">
                <span>Potência Radiativa Total</span>
                <Zap size={16} color="#ef4444" />
              </div>
              <strong className="mono">
                {kpisMonitoramento.frpTotalMw.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} MW
              </strong>
              <small className="muted">Intensidade energética acumulada</small>
            </div>
          </section>

          <main className="grid-main">
            <section className="card">
              <div className="card-head">
                <div>
                  <h2>Mapa de Focos e Frentes Ativas</h2>
                  <small className="muted">Agrupamento tático DBSCAN (4,5 km) • Satélite híbrido com estradas e comunidades</small>
                </div>
                <div className="head-actions">
                  <div className="seg-group">
                    {([24, 48, 168] as const).map((h) => (
                      <button
                        key={h}
                        type="button"
                        className={`seg-btn ${janelaHoras === h ? 'on' : ''}`}
                        onClick={() => setJanelaHoras(h)}
                      >
                        {h === 168 ? '7 dias' : `${h}h`}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="btn-secondary" onClick={capturarGPS}>
                    <Compass size={15} /> Usar Meu GPS
                  </button>
                </div>
              </div>

              <MapaTatico
                municipio={municipioAtual}
                focos={focos}
                perimetros={perimetrosGeoJSON}
                frenteSelecionada={frenteAlvo}
                onSelectFrente={(cid) => {
                  const achada = frentes.find((f) => f.clusterId === cid);
                  if (achada) setFrenteAlvo(achada);
                }}
                onSelectCoord={handleCoordDoMapa}
              />

              {avisoCoordMapa && (
                <div className="coord-toast">
                  📍 Coordenada capturada do mapa (<span className="mono">{formLat}, {formLon}</span>) — abra "+ Nova Ocorrência em Campo" para registrar.
                </div>
              )}

              {frenteAlvo && (
                <div className="compass-box">
                  <div className="compass-head">
                    <strong>Alvo Tático — Frente #{frenteAlvo.clusterId}</strong>
                    <span className={`badge ${frenteAlvo.severidade}`}>{frenteAlvo.severidade}</span>
                  </div>
                  <div className="mono-line">
                    GMS (Rádio/Garmin): <code className="mono">{paraGMS(frenteAlvo.centroLat, 'lat')}</code> |{' '}
                    <code className="mono">{paraGMS(frenteAlvo.centroLon, 'lon')}</code>
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {frenteAlvo.totalFocos} focos • {frenteAlvo.areaHectares.toLocaleString('pt-BR')} ha • Potência {frenteAlvo.frpTotalMw} MW
                  </div>
                  {nav ? (
                    <div style={{ marginTop: 4 }}>
                      Distância: <strong className="mono">{nav.distanciaKm.toFixed(2)} km</strong> | Azimute:{' '}
                      <strong className="mono">{nav.azimute.toFixed(0)}° ({nav.rumoCardeal})</strong>
                    </div>
                  ) : (
                    <small className="muted">Clique em "Usar Meu GPS" para calcular distância e rumo azimutal.</small>
                  )}
                </div>
              )}
            </section>

            <aside className="side-col">
              <div className="card">
                <div className="frentes-header">
                  <h3>Frentes de Combate ({frentesFiltradas.length})</h3>
                  <div className="seg-group compact">
                    {([
                      { id: 'TODAS', lbl: 'Todas' },
                      { id: 'CRÍTICA', lbl: 'Críticas' },
                      { id: 'ALTA', lbl: 'Altas' },
                    ] as const).map((op) => (
                      <button
                        key={op.id}
                        type="button"
                        className={`seg-btn ${filtroFrente === op.id ? 'on' : ''}`}
                        onClick={() => setFiltroFrente(op.id)}
                      >
                        {op.lbl}
                      </button>
                    ))}
                  </div>
                </div>

                {frentesFiltradas.length === 0 ? (
                  <p className="muted">Nenhuma frente com este filtro nas últimas {janelaHoras}h.</p>
                ) : (
                  <div className={`lista-frentes ${formAberto ? 'compact-list' : 'expanded-list'}`}>
                    {frentesFiltradas.map((fr) => (
                      <button
                        key={fr.clusterId}
                        type="button"
                        className={`frente-item ${frenteAlvo?.clusterId === fr.clusterId ? 'sel' : ''}`}
                        onClick={() => setFrenteAlvo(fr)}
                      >
                        <div className="frente-top">
                          <strong>Frente #{fr.clusterId}</strong>
                          <span className={`badge ${fr.severidade}`}>{fr.severidade}</span>
                        </div>
                        <small className="mono">
                          {fr.totalFocos} focos • {fr.areaHectares.toLocaleString('pt-BR')} ha • {fr.frpTotalMw} MW
                        </small>
                        <small className="muted block-coord mono">
                          {paraGMS(fr.centroLat, 'lat')} • {paraGMS(fr.centroLon, 'lon')}
                        </small>
                        {fr.jurisdicoes.length > 0 && (
                          <small className="jurisd">{fr.jurisdicoes.join(' | ')}</small>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="card">
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={() => setFormAberto((v) => !v)}
                >
                  <span><PlusCircle size={16} color="#fb923c" /> + Nova Ocorrência em Campo</span>
                  {formAberto ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {formLat && formLon && !formAberto && (
                  <small className="coord-ready mono" onClick={() => setFormAberto(true)}>
                    📍 Ponto pronto: {formLat}, {formLon} (clique para abrir)
                  </small>
                )}

                {formAberto && (
                  <form className="campo-form" onSubmit={registrarOcorrenciaCampo}>
                    <div className="row2">
                      <input className="mono" placeholder="Latitude" value={formLat} onChange={(e) => setFormLat(e.target.value)} required />
                      <input className="mono" placeholder="Longitude" value={formLon} onChange={(e) => setFormLon(e.target.value)} required />
                    </div>
                    <input
                      placeholder="Local de referência (ramal, comunidade, rio)"
                      value={formRef}
                      onChange={(e) => setFormRef(e.target.value)}
                    />
                    <select value={formPorte} onChange={(e) => setFormPorte(e.target.value)}>
                      <option value="Pequeno">Porte Pequeno (Inicial)</option>
                      <option value="Médio">Porte Médio (Expansão)</option>
                      <option value="Grande">Porte Grande (Crítico)</option>
                    </select>
                    <textarea
                      rows={2}
                      placeholder="Observações da brigada em campo..."
                      value={formObs}
                      onChange={(e) => setFormObs(e.target.value)}
                    />
                    <button type="submit" className="btn-primary">
                      <Send size={14} /> {online ? 'Enviar ao PostGIS' : 'Salvar Offline (Modo Floresta)'}
                    </button>
                    {msgCampo && <small className="ok-msg">{msgCampo}</small>}
                  </form>
                )}
              </div>
            </aside>
          </main>
        </>
      ) : (
        <main className="ia-grid">
          {!ultimaPrev ? (
            <div className="card">
              <p>Nenhum boletim preditivo gravado ainda para este município. Execute o workflow <code>ia_diaria.yml</code> no GitHub Actions.</p>
            </div>
          ) : (
            <>
              <section className="card risco-banner" style={{ borderLeftColor: COR_RISCO[ultimaPrev.nivel_risco] }}>
                <div className="risco-row">
                  <div>
                    <span className="muted">Boletim Preditivo Oficial — {ultimaPrev.municipio} ({ultimaPrev.data_referencia})</span>
                    <h2 style={{ color: COR_RISCO[ultimaPrev.nivel_risco] }}>
                      <ShieldAlert size={22} /> NÍVEL DE RISCO: {ultimaPrev.nivel_risco}
                    </h2>
                    <small className="muted">
                      Motor: {ultimaPrev.modelo_utilizado} • Probabilidade de Dia Crítico (≥5 focos em 24h):{' '}
                      <strong className="mono">{(ultimaPrev.prob_dia_critico_d1 * 100).toFixed(1)}%</strong>
                    </small>
                  </div>
                  <button className="btn-pdf" onClick={handleEmitirPDF} disabled={gerandoPdf}>
                    <FileText size={16} />
                    {gerandoPdf ? 'Gerando PDF...' : 'Emitir Boletim Oficial (PDF)'}
                  </button>
                </div>
              </section>

              <section className="cards-3">
                {[
                  { lbl: 'D+1 (Próximas 24h)', val: ultimaPrev.focos_previstos_d1, inf: ultimaPrev.ic_inf_d1, sup: ultimaPrev.ic_sup_d1, prob: ultimaPrev.prob_dia_critico_d1 },
                  { lbl: 'D+2 (Em 48 horas)', val: ultimaPrev.focos_previstos_d2, inf: ultimaPrev.ic_inf_d2, sup: ultimaPrev.ic_sup_d2, prob: ultimaPrev.prob_dia_critico_d2 },
                  { lbl: 'D+3 (Em 72 horas)', val: ultimaPrev.focos_previstos_d3, inf: ultimaPrev.ic_inf_d3, sup: ultimaPrev.ic_sup_d3, prob: ultimaPrev.prob_dia_critico_d3 },
                ].map((c) => (
                  <div className="card kpi" key={c.lbl}>
                    <span className="muted">{c.lbl}</span>
                    <strong className="mono">{Number(c.val).toFixed(1)} <small className="unit">focos</small></strong>
                    <small className="mono">IC 95% Conformal: {fmtIC95(Number(c.inf), Number(c.sup))}</small>
                    <small>Chance de Dia Crítico: <strong className="mono">{(Number(c.prob) * 100).toFixed(0)}%</strong></small>
                  </div>
                ))}
              </section>

              <section className="grid-main">
                <div className="card">
                  <div className="card-head">
                    <div>
                      <h2>Mapa de Zonas com Maior Probabilidade de Fogo (Próximas 72h)</h2>
                      <small className="muted">Hexágonos 6 km • Reincidência histórica (8 anos) + Vento previsto + Secura local</small>
                    </div>
                  </div>
                  <MapaRiscoIA
                    municipio={municipioAtual}
                    zonas={zonasRisco}
                    zonaSelecionada={zonaAlvo}
                    onSelectZona={setZonaAlvo}
                  />
                  {zonaAlvo && (
                    <div className="compass-box">
                      <div className="compass-head">
                        <strong>
                          Setor Selecionado — Score <span className="mono">{Number(zonaAlvo.score_risco).toFixed(1)}/100</span>
                        </strong>
                        <span className={`badge ${zonaAlvo.nivel_risco === 'CRÍTICO' ? 'CRÍTICA' : zonaAlvo.nivel_risco === 'ALTO' ? 'ALTA' : 'MODERADA'}`}>
                          {zonaAlvo.nivel_risco}
                        </span>
                      </div>
                      <div style={{ margin: '4px 0' }}>{zonaAlvo.motivo_principal}</div>
                      <div className="mono-line">
                        GMS: <code className="mono">{paraGMS(zonaAlvo.centro_lat, 'lat')}</code> |{' '}
                        <code className="mono">{paraGMS(zonaAlvo.centro_lon, 'lon')}</code> • Vento:{' '}
                        <strong className="mono">{Number(zonaAlvo.velocidade_vento_kmh).toFixed(0)} km/h</strong> • Chuva 72h:{' '}
                        <strong className="mono">{Number(zonaAlvo.chuva_prevista_72h_mm).toFixed(1)} mm</strong>
                      </div>
                      <small className="muted">
                        Composição física: Reincidência {zonaAlvo.fator_reincidencia}% • Contágio/Vento{' '}
                        {zonaAlvo.fator_contagio_vento}% • Microclima seco {zonaAlvo.fator_microclima}%
                      </small>
                    </div>
                  )}
                </div>

                <div className="card">
                  <h3>Top Setores para Patrulha ({zonasRisco.length})</h3>
                  {zonasRisco.length === 0 ? (
                    <p className="muted">Nenhuma zona atingiu risco moderado (&ge;35/100) para as próximas 72h.</p>
                  ) : (
                    <div className="lista-frentes expanded-list">
                      {zonasRisco.slice(0, 15).map((z, idx) => (
                        <button
                          key={z.hex_id}
                          type="button"
                          className={`frente-item ${zonaAlvo?.hex_id === z.hex_id ? 'sel' : ''}`}
                          onClick={() => setZonaAlvo(z)}
                        >
                          <div className="frente-top">
                            <strong>Setor #{idx + 1} • Score <span className="mono">{Number(z.score_risco).toFixed(1)}</span></strong>
                            <span className={`badge ${z.nivel_risco === 'CRÍTICO' ? 'CRÍTICA' : z.nivel_risco === 'ALTO' ? 'ALTA' : 'MODERADA'}`}>
                              {z.nivel_risco}
                            </span>
                          </div>
                          <small>{z.motivo_principal}</small>
                          <small className="jurisd mono">
                            {paraGMS(z.centro_lat, 'lat')} | {paraGMS(z.centro_lon, 'lon')}
                          </small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <section className="cards-4">
                <div className="card mini">
                  <span>VPD Atmosférico (Secura do Ar)</span>
                  <strong className="mono">{ultimaPrev.vpd_kpa} kPa</strong>
                  {tagsBio && <em className={`bio-pill ${tagsBio.vpd.tom}`}>{tagsBio.vpd.txt}</em>}
                </div>
                <div className="card mini">
                  <span>Índice de Nesterov (G)</span>
                  <strong className="mono">{Number(ultimaPrev.indice_nesterov).toLocaleString('pt-BR')}</strong>
                  {tagsBio && <em className={`bio-pill ${tagsBio.nesterov.tom}`}>{tagsBio.nesterov.txt}</em>}
                </div>
                <div className="card mini">
                  <span>Índice de Angström (I_A)</span>
                  <strong className="mono">{ultimaPrev.indice_angstrom}</strong>
                  {tagsBio && <em className={`bio-pill ${tagsBio.angstrom.tom}`}>{tagsBio.angstrom.txt}</em>}
                </div>
                <div className="card mini">
                  <span>Umidade do Solo (0–7 cm) &amp; Seca</span>
                  <strong className="mono">{ultimaPrev.umidade_solo_pct}% • {ultimaPrev.dias_sem_chuva}d</strong>
                  {tagsBio && <em className={`bio-pill ${tagsBio.solo.tom}`}>{tagsBio.solo.txt}</em>}
                </div>
              </section>

              <section className="card">
                <h3><Activity size={16} /> Explicabilidade Física do Dia (XAI)</h3>
                <div className="xai-chips">
                  <span className="xai-chip">Focos VIIRS ontem: <strong className="mono">{String(xai.focos_ontem_snpp ?? '—')}</strong></span>
                  <span className="xai-chip">UR mín. prevista D+1: <strong className="mono">{String(xai.ur_min_prevista_d1 ?? '—')}%</strong></span>
                  <span className="xai-chip">Chuva prevista 72h: <strong className="mono">{String(xai.chuva_prevista_72h_mm ?? '—')} mm</strong></span>
                  <span className="xai-chip">Variação Solo 7d: <strong className="mono">{String(xai.delta_solo_7d_pct ?? '—')}%</strong></span>
                  <span className={`xai-chip ${xai.fim_de_semana_d1 ? 'alerta' : ''}`}>
                    Ciclo antrópico: <strong>{xai.fim_de_semana_d1 ? 'Fim de semana (Sex–Dom)' : 'Dia útil'}</strong>
                  </span>
                </div>
              </section>

              <section className="card">
                <h3>Série Real (14 dias — VIIRS 375 m) + Projeção CurupiraNet v2 (72h)</h3>
                <div style={{ width: '100%', height: 270 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={dadosGraficoContinuo}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.16)" />
                      <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} />
                      <YAxis stroke="#94a3b8" fontSize={11} />
                      <Tooltip
                        contentStyle={{ background: '#0b1220', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 10 }}
                        formatter={(value, name, item) => {
                          if (name === 'IC 95% (teto visual)' && item?.payload?.icSupReal !== undefined) {
                            return [`${Number(item.payload.icSupReal).toFixed(1)} focos`, 'IC 95% Sup. (Real)'];
                          }
                          return [value, name];
                        }}
                      />
                      <Legend />
                      {dataDivisoria && (
                        <ReferenceLine x={dataDivisoria} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: 'Hoje', fill: '#94a3b8', fontSize: 11 }} />
                      )}
                      <Area type="monotone" dataKey="icSupVisual" fill="#38bdf8" fillOpacity={0.16} stroke="none" name="IC 95% (teto visual)" />
                      <Line type="monotone" dataKey="observado" stroke="#38bdf8" strokeWidth={2.5} dot={{ r: 3 }} name="Observado (VIIRS 375 m)" />
                      <Line type="monotone" dataKey="previsto" stroke="#f97316" strokeWidth={2.5} strokeDasharray="6 3" dot={{ r: 4 }} name="Previsão IA (72h)" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="card">
                <h3>Auditoria Científica — Expanding Window CV (4 Folds, Oriximiná-PA)</h3>
                <div className="table-scroll">
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th>Fold</th><th>Regime</th><th>MAE Naive</th><th>MAE Curupira v2</th><th>R² 72h</th><th>F1 Crítico</th><th>PICP 95%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {TABELA_4FOLDS.map((r) => (
                        <tr key={r.fold}>
                          <td>{r.fold}</td><td>{r.regime}</td><td className="mono">{r.maeNaive}</td><td><strong className="mono">{r.maeCurupira}</strong></td>
                          <td className="mono">{r.r2}</td><td className="mono">{r.f1}</td><td className="mono">{r.picp}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </main>
      )}
    </div>
  );
}
