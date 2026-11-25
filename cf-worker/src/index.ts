interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  NASA_FIRMS_KEY: string;
  SYNC_TOKEN: string; // Token simples para disparar sincronização manual via HTTP
}

interface MunicipioRow {
  codigo_ibge: string;
  nome: string;
  bbox_w: number;
  bbox_s: number;
  bbox_e: number;
  bbox_n: number;
}

interface FocoPayload {
  lat: number;
  lon: number;
  temperatura_k: number | null;
  frp_mw: number;
  satelite: string;
  confianca: string;
  origem: string;
  registado_em: string;
}

// Todos os sensores VIIRS ativos (o mapa exibe os 3; a IA filtra apenas VIIRS_SNPP)
const SENSORES = [
  { api: "VIIRS_SNPP_NRT", label: "VIIRS_SNPP" },
  { api: "VIIRS_NOAA20_NRT", label: "VIIRS_NOAA20" },
  { api: "VIIRS_NOAA21_NRT", label: "VIIRS_NOAA21" },
];

function mapearConfianca(raw: string): string | null {
  const c = (raw || "").trim().toLowerCase();
  if (c === "l" || c === "low") return null; // Descarta baixa confiança
  if (c === "h" || c === "high") return "ALTA";
  return "NOMINAL";
}

function parseCsvFirms(csvText: string, satLabel: string): FocoPayload[] {
  const linhas = csvText.trim().split(/\r?\n/);
  if (linhas.length < 2) return [];

  const cols = linhas[0].split(",").map((h) => h.trim().toLowerCase());
  const idxLat = cols.indexOf("latitude");
  const idxLon = cols.indexOf("longitude");
  const idxTb = cols.indexOf("bright_ti4") !== -1 ? cols.indexOf("bright_ti4") : cols.indexOf("brightness");
  const idxDate = cols.indexOf("acq_date");
  const idxTime = cols.indexOf("acq_time");
  const idxConf = cols.indexOf("confidence");
  const idxFrp = cols.indexOf("frp");
  const idxType = cols.indexOf("type"); // Presente em SP; ausente em NRT

  if (idxLat === -1 || idxLon === -1 || idxDate === -1 || idxTime === -1) return [];

  const focos: FocoPayload[] = [];
  for (let i = 1; i < linhas.length; i++) {
    const v = linhas[i].split(",");
    if (v.length < cols.length) continue;

    // Se houver coluna type, mantém apenas incêndios vegetativos (0)
    if (idxType !== -1 && v[idxType]?.trim() !== "0") continue;

    const conf = mapearConfianca(idxConf !== -1 ? v[idxConf] : "n");
    if (!conf) continue;

    const lat = Number(v[idxLat]);
    const lon = Number(v[idxLon]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const hhmm = (v[idxTime] || "0000").trim().padStart(4, "0");
    const isoUtc = `${v[idxDate].trim()}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`;
    const tb = idxTb !== -1 && v[idxTb] ? Number(v[idxTb]) : null;
    const frp = idxFrp !== -1 && v[idxFrp] ? Number(v[idxFrp]) : 0;

    focos.push({
      lat,
      lon,
      temperatura_k: tb !== null && !Number.isNaN(tb) ? tb : null,
      frp_mw: !Number.isNaN(frp) ? frp : 0,
      satelite: satLabel,
      confianca: conf,
      origem: "SATELITE_NASA",
      registado_em: isoUtc,
    });
  }
  return focos;
}

async function sincronizarTodosMunicipios(env: Env, dias = 2): Promise<Record<string, number>> {
  const baseUrl = env.SUPABASE_URL.replace(/\/$/, "");
  const sbHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Busca todos os municípios ativos no banco multi-tenant
  const resMun = await fetch(
    `${baseUrl}/rest/v1/municipios_ibge?ativo=eq.true&select=codigo_ibge,nome,bbox_w,bbox_s,bbox_e,bbox_n`,
    { headers: sbHeaders }
  );
  if (!resMun.ok) {
    throw new Error(`Erro ao listar municípios: ${resMun.status} ${await resMun.text()}`);
  }
  const municipios: MunicipioRow[] = await resMun.json();
  const resumo: Record<string, number> = {};

  // 2. Para cada município, consulta os 3 satélites VIIRS e grava via RPC PostGIS
  for (const mun of municipios) {
    const bbox = `${mun.bbox_w},${mun.bbox_s},${mun.bbox_e},${mun.bbox_n}`;
    const loteMunicipio: FocoPayload[] = [];

    for (const sensor of SENSORES) {
      const urlFirms = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.NASA_FIRMS_KEY}/${sensor.api}/${bbox}/${dias}`;
      try {
        const r = await fetch(urlFirms, {
          headers: { "User-Agent": "CurupiraIA-CFWorker/1.0" },
        });
        if (r.ok) {
          const txt = await r.text();
          if (txt.startsWith("latitude")) {
            loteMunicipio.push(...parseCsvFirms(txt, sensor.label));
          }
        }
      } catch (err) {
        console.error(`Falha ${sensor.label} em ${mun.nome}:`, err);
      }
    }

    if (loteMunicipio.length === 0) {
      resumo[mun.nome] = 0;
      continue;
    }

    const resRpc = await fetch(`${baseUrl}/rest/v1/rpc/inserir_focos_filtrados`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        p_codigo_ibge: mun.codigo_ibge,
        p_municipio: mun.nome,
        p_focos: loteMunicipio,
      }),
    });

    if (!resRpc.ok) {
      console.error(`Erro RPC ${mun.nome}:`, await resRpc.text());
      resumo[mun.nome] = -1;
    } else {
      resumo[mun.nome] = (await resRpc.json()) as number;
    }
  }

  return resumo;
}

export default {
  // Rota HTTP para monitoramento e disparo manual protegido
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "curupira-firms-worker" });
    }

    if (url.pathname === "/sync" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.SYNC_TOKEN || auth !== `Bearer ${env.SYNC_TOKEN}`) {
        return Response.json({ error: "Não autorizado" }, { status: 401 });
      }
      const dias = Math.min(10, Math.max(1, Number(url.searchParams.get("dias") || "2")));
      const resumo = await sincronizarTodosMunicipios(env, dias);
      return Response.json({ status: "sincronizado", dias, inseridos_por_municipio: resumo });
    }

    return Response.json({ error: "Rota não encontrada" }, { status: 404 });
  },

  // Execução automática a cada 2 horas (Cloudflare Cron Trigger)
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sincronizarTodosMunicipios(env, 2).then((resumo) => {
        console.log("Sincronização NASA FIRMS concluída:", JSON.stringify(resumo));
      })
    );
  },
};
