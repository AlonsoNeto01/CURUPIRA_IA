import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import requests

TZ_BELEM = ZoneInfo("America/Belem")
EARTH_RADIUS_KM = 6371.0


def _haversine_e_azimute(lat1: np.ndarray, lon1: np.ndarray, lat2: np.ndarray, lon2: np.ndarray):
    """
    Calcula matriz de distância (km) e azimute (0–360°, de 1 -> 2)
    entre N pontos de origem (lat1, lon1) e M pontos de destino (lat2, lon2).
    """
    phi1 = np.radians(lat1)[:, None]
    phi2 = np.radians(lat2)[None, :]
    dphi = phi2 - phi1
    dlam = np.radians(lon2)[None, :] - np.radians(lon1)[:, None]

    a = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlam / 2.0) ** 2
    dist_km = 2.0 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

    y = np.sin(dlam) * np.cos(phi2)
    x = np.cos(phi1) * np.sin(phi2) - np.sin(phi1) * np.cos(phi2) * np.cos(dlam)
    azimute = (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0
    return dist_km, azimute


def _coletar_nwp_por_ponto(pontos_grade: list) -> list[dict]:
    """Busca chuva 72h, vento máximo e direção dominante do vento em cada ponto de grade."""
    lats = ",".join(str(p[0]) for p in pontos_grade)
    lons = ",".join(str(p[1]) for p in pontos_grade)
    params = {
        "latitude": lats,
        "longitude": lons,
        "timezone": "America/Belem",
        "forecast_days": 3,
        "daily": [
            "precipitation_sum",
            "wind_speed_10m_max",
            "wind_direction_10m_dominant",
            "temperature_2m_max",
        ],
    }
    r = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=45)
    r.raise_for_status()
    js = r.json()
    if isinstance(js, dict):
        js = [js]

    saida = []
    for idx, item in enumerate(js):
        d = item.get("daily", {})
        chuvas = [float(v or 0.0) for v in d.get("precipitation_sum", [0, 0, 0])[:3]]
        ventos = [float(v or 0.0) for v in d.get("wind_speed_10m_max", [8, 8, 8])[:3]]
        dirs = [float(v or 90.0) for v in d.get("wind_direction_10m_dominant", [90, 90, 90])[:3]]
        tmaxs = [float(v or 32.0) for v in d.get("temperature_2m_max", [32, 32, 32])[:3]]

        # Média vetorial da direção do vento (evita distorção perto de 0°/360°)
        rad = np.radians(dirs)
        dir_media = (math.degrees(math.atan2(float(np.mean(np.sin(rad))), float(np.mean(np.cos(rad))))) + 360.0) % 360.0

        saida.append(
            {
                "lat": float(pontos_grade[idx][0]),
                "lon": float(pontos_grade[idx][1]),
                "chuva_72h": float(sum(chuvas)),
                "vento_kmh": float(np.mean(ventos)),
                "vento_dir_from": float(dir_media),
                "tmax_media": float(np.mean(tmaxs)),
            }
        )
    return saida


def _carregar_grade_paginada(sb, codigo_ibge: str) -> list[dict]:
    rows = []
    offset = 0
    while True:
        res = (
            sb.table("grade_hexagonal_municipio")
            .select("hex_id, centro_lat, centro_lon, focos_por_mes, risco_base_anual, geojson")
            .eq("codigo_ibge", codigo_ibge)
            .range(offset, offset + 999)
            .execute()
        )
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows


def _carregar_focos_ativos_48h(sb, codigo_ibge: str) -> list[dict]:
    corte = (datetime.now(TZ_BELEM) - timedelta(hours=48)).isoformat()
    res = (
        sb.table("focos_incendio")
        .select("lat, lon, frp_mw")
        .eq("codigo_ibge", codigo_ibge)
        .gte("registado_em", corte)
        .limit(1500)
        .execute()
    )
    return res.data or []


def _rumo_cardeal(graus: float) -> str:
    pontos = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"]
    return pontos[int(round(graus / 45.0)) % 8]


def calcular_e_gravar_risco_espacial(
    sb,
    codigo_ibge: str,
    municipio: str,
    pontos_grade: list,
    payload_ia: dict,
) -> int:
    """
    Calcula o mapa de risco espacial 72h por hexágono combinando:
      1) Reincidência sazonal (2018–2025, mês atual ± 1 mês)
      2) Contágio de focos ativos 48h + alinhamento a favor do vento (downwind)
      3) Microclima local NWP (chuva 72h e temperatura interpoladas por IDW)
      4) Modulação pela saída municipal da CurupiraNet v2
    """
    hexes = _carregar_grade_paginada(sb, codigo_ibge)
    if not hexes:
        print(f"   ⚠️ Sem grade hexagonal para {municipio} ({codigo_ibge}).")
        return 0

    n_hex = len(hexes)
    hex_lats = np.array([float(h["centro_lat"]) for h in hexes], dtype=np.float64)
    hex_lons = np.array([float(h["centro_lon"]) for h in hexes], dtype=np.float64)

    # ------------------------------------------------------------------
    # 1. FATOR REINCIDÊNCIA SAZONAL [0, 1] (mês atual + vizinhos ±1 mês)
    # ------------------------------------------------------------------
    data_ref = payload_ia["data_referencia"]
    mes_idx = datetime.strptime(data_ref, "%Y-%m-%d").month - 1  # 0..11
    m_prev = (mes_idx - 1) % 12
    m_next = (mes_idx + 1) % 12

    sazonal_raw = np.zeros(n_hex, dtype=np.float64)
    base_anual = np.zeros(n_hex, dtype=np.float64)
    for i, h in enumerate(hexes):
        vet = h.get("focos_por_mes") or [0] * 12
        if len(vet) == 12:
            # Peso maior no mês corrente (0.5) e nos adjacentes (0.25 cada)
            sazonal_raw[i] = 0.50 * float(vet[mes_idx]) + 0.25 * float(vet[m_prev]) + 0.25 * float(vet[m_next])
        base_anual[i] = float(h.get("risco_base_anual") or 0.0)

    saz_log = np.log1p(sazonal_raw)
    p98 = float(np.percentile(saz_log[saz_log > 0], 98)) if np.any(saz_log > 0) else 1.0
    saz_norm = np.clip(saz_log / max(p98, 1e-6), 0.0, 1.0)
    fator_reinc = np.clip(0.70 * saz_norm + 0.30 * base_anual, 0.0, 1.0)

    # ------------------------------------------------------------------
    # 2. INTERPOLAÇÃO ESPACIAL IDW DO MICROCLIMA E VENTO (NWP 72h)
    # ------------------------------------------------------------------
    pts_nwp = _coletar_nwp_por_ponto(pontos_grade)
    p_lats = np.array([p["lat"] for p in pts_nwp], dtype=np.float64)
    p_lons = np.array([p["lon"] for p in pts_nwp], dtype=np.float64)

    dist_p_h, _ = _haversine_e_azimute(p_lats, p_lons, hex_lats, hex_lons)  # (P, H)
    pesos_idw = 1.0 / np.maximum(dist_p_h, 2.0) ** 2
    pesos_idw /= pesos_idw.sum(axis=0, keepdims=True)

    chuvas_p = np.array([p["chuva_72h"] for p in pts_nwp], dtype=np.float64)
    ventos_p = np.array([p["vento_kmh"] for p in pts_nwp], dtype=np.float64)
    tmax_p = np.array([p["tmax_media"] for p in pts_nwp], dtype=np.float64)
    dirs_rad = np.radians([p["vento_dir_from"] for p in pts_nwp])

    chuva_hex = pesos_idw.T @ chuvas_p
    vento_hex = pesos_idw.T @ ventos_p
    tmax_hex = pesos_idw.T @ tmax_p
    dir_sin = pesos_idw.T @ np.sin(dirs_rad)
    dir_cos = pesos_idw.T @ np.cos(dirs_rad)
    vento_from_hex = (np.degrees(np.arctan2(dir_sin, dir_cos)) + 360.0) % 360.0
    # Padrão meteorológico: vento_from indica DE ONDE vem -> fogo propaga para +180° (downwind)
    vento_to_hex = (vento_from_hex + 180.0) % 360.0

    # Secura local: chuva >= 20mm derruba risco local; Tmax >= 35°C e VPD alto elevam
    vpd_mun = float(payload_ia.get("vpd_kpa") or 1.5)
    solo_mun = float(payload_ia.get("umidade_solo_pct") or 30.0)
    secura_chuva = np.exp(-chuva_hex / 14.0)  # 0 mm -> 1.0 | 15 mm -> 0.34 | 30 mm -> 0.12
    estresse_term = np.clip((tmax_hex - 28.0) / 10.0, 0.0, 1.0)
    estresse_base = np.clip(0.5 * (vpd_mun / 3.0) + 0.5 * ((45.0 - solo_mun) / 30.0), 0.15, 1.0)
    fator_micro = np.clip(secura_chuva * (0.45 + 0.35 * estresse_term + 0.20 * estresse_base), 0.0, 1.0)

    # ------------------------------------------------------------------
    # 3. CONTÁGIO ATIVO (48h) + VETOR DO VENTO (PROPAGAÇÃO DOWNWIND)
    # ------------------------------------------------------------------
    focos_48h = _carregar_focos_ativos_48h(sb, codigo_ibge)
    fator_contagio = np.zeros(n_hex, dtype=np.float64)

    if focos_48h:
        f_lats = np.array([float(f["lat"]) for f in focos_48h], dtype=np.float64)
        f_lons = np.array([float(f["lon"]) for f in focos_48h], dtype=np.float64)
        f_frp = np.array([max(1.0, float(f.get("frp_mw") or 5.0)) for f in focos_48h], dtype=np.float64)
        peso_foco = np.log1p(f_frp) / 4.0  # Peso logarítmico pela potência radiativa

        dist_f_h, az_f_h = _haversine_e_azimute(f_lats, f_lons, hex_lats, hex_lons)  # (F, H)

        # Núcleo de proximidade (raio de decaimento ~ 12 km)
        prox = np.exp(-((dist_f_h / 12.0) ** 2))
        prox[dist_f_h > 32.0] = 0.0

        # Alinhamento com o vetor downwind do vento previsto (bônus até +75% a favor do vento)
        delta_ang = np.radians(az_f_h - vento_to_hex[None, :])
        alinhamento = np.maximum(0.0, np.cos(delta_ang))
        intensidade_vento = np.clip(vento_hex[None, :] / 18.0, 0.2, 1.2)
        bonus_vento = 1.0 + 0.75 * alinhamento * intensidade_vento
        # Dentro do próprio hexágono (< 6 km), o contágio independe do alinhamento direcional
        bonus_vento = np.where(dist_f_h < 6.0, 1.35, bonus_vento)

        energia_contagio = (prox * bonus_vento * peso_foco[:, None]).sum(axis=0)
        # Saturação suave em [0, 1]
        fator_contagio = 1.0 - np.exp(-energia_contagio / 2.2)

    # ------------------------------------------------------------------
    # 4. COMPOSIÇÃO FINAL + MODULAÇÃO PELA CURUPIRANET V2
    # ------------------------------------------------------------------
    prob_crit_d1 = float(payload_ia.get("prob_dia_critico_d1") or 0.0)
    focos_72h_tot = (
        float(payload_ia.get("focos_previstos_d1") or 0.0)
        + float(payload_ia.get("focos_previstos_d2") or 0.0)
        + float(payload_ia.get("focos_previstos_d3") or 0.0)
    )

    # Intensidade municipal vinda da rede neural [0.45 .. 1.15]
    mod_ia = 0.45 + 0.70 * max(prob_crit_d1, min(1.0, focos_72h_tot / 35.0))

    # Combinação física: reincidência + contágio direcional + microclima seco
    score_bruto = (0.45 * fator_reinc + 0.35 * fator_contagio + 0.20 * fator_micro) * mod_ia
    # Se o próprio hexágono está com fogo intenso ou diretamente sob pluma downwind seca, preserva piso crítico
    score_bruto = np.maximum(score_bruto, 0.85 * fator_contagio * (0.5 + 0.5 * secura_chuva))
    score_pct = np.clip(score_bruto * 100.0, 0.0, 99.9)

    # Seleciona hexágonos com risco >= MODERADO (score >= 35), limitado aos Top 80 por município
    ordem = np.argsort(-score_pct)
    selecionados = [int(i) for i in ordem if score_pct[i] >= 35.0][:80]

    # Limpa gravações anteriores do mesmo dia/município para manter mapa limpo
    sb.table("risco_espacial_72h").delete().eq("codigo_ibge", codigo_ibge).eq("data_referencia", data_ref).execute()

    if not selecionados:
        print(f"   🟢 {municipio}: nenhum hexágono atingiu risco moderado (>=35) para 72h.")
        return 0

    # Distribui os focos previstos pela CurupiraNet v2 proporcionalmente aos pesos dos hexágonos selecionados
    pesos_dist = np.array([score_pct[i] ** 1.5 for i in selecionados], dtype=np.float64)
    pesos_dist /= max(pesos_dist.sum(), 1e-6)

    registros = []
    for k, i in enumerate(selecionados):
        sc = float(score_pct[i])
        nivel = "CRÍTICO" if sc >= 72.0 else ("ALTO" if sc >= 52.0 else "MODERADO")
        rumo_prop = _rumo_cardeal(float(vento_to_hex[i]))

        # Explicação física legível para a Defesa Civil e PDF
        motivos = []
        if fator_contagio[i] >= 0.45:
            motivos.append(f"Contágio ativo c/ vento p/ {rumo_prop} ({vento_hex[i]:.0f} km/h)")
        if fator_reinc[i] >= 0.55:
            motivos.append("Alta reincidência histórica no bimestre")
        if chuva_hex[i] < 3.0 and fator_micro[i] >= 0.55:
            motivos.append(f"Secura severa s/ chuva 72h ({chuva_hex[i]:.1f} mm)")
        elif chuva_hex[i] >= 10.0:
            motivos.append(f"Chuva prevista ({chuva_hex[i]:.0f} mm) atenua propagação")
        if not motivos:
            motivos.append("Vulnerabilidade moderada por histórico e seca local")

        registros.append(
            {
                "codigo_ibge": codigo_ibge,
                "hex_id": hexes[i]["hex_id"],
                "data_referencia": data_ref,
                "centro_lat": round(float(hex_lats[i]), 5),
                "centro_lon": round(float(hex_lons[i]), 5),
                "score_risco": round(sc, 2),
                "nivel_risco": nivel,
                "focos_esperados_72h": round(float(focos_72h_tot * pesos_dist[k]), 2),
                "fator_reincidencia": round(float(fator_reinc[i] * 100.0), 1),
                "fator_contagio_vento": round(float(fator_contagio[i] * 100.0), 1),
                "fator_microclima": round(float(fator_micro[i] * 100.0), 1),
                "direcao_vento_graus": round(float(vento_to_hex[i]), 1),
                "velocidade_vento_kmh": round(float(vento_hex[i]), 1),
                "chuva_prevista_72h_mm": round(float(chuva_hex[i]), 1),
                "motivo_principal": " + ".join(motivos[:2]),
                "geojson": hexes[i]["geojson"],
            }
        )

    sb.table("risco_espacial_72h").insert(registros).execute()
    criticos = sum(1 for r in registros if r["nivel_risco"] == "CRÍTICO")
    altos = sum(1 for r in registros if r["nivel_risco"] == "ALTO")
    print(f"   🗺️  {municipio}: {len(registros)} zonas mapeadas ({criticos} críticas, {altos} altas).")
    return len(registros)
