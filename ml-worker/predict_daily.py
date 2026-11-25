import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import joblib
import numpy as np
import pandas as pd
import requests
import tensorflow as tf
from tensorflow import keras
from supabase import create_client

from features import adaptar_umidade_solo_forecast, calcular_vpd, engenharia_biofisica

TZ_BELEM = ZoneInfo("America/Belem")
LOOKBACK = 14
HORIZON = 3
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

SUPABASE_URL = os.environ["SUPABASE_URL"].strip().rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"].strip()
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def coletar_clima_e_nwp(pontos_grade: list) -> pd.DataFrame:
    """Coleta últimos 16 dias + hoje + 3 dias de previsão (D+1..D+3) no Open-Meteo."""
    frames = []
    for lat, lon in pontos_grade:
        params = {
            "latitude": lat,
            "longitude": lon,
            "timezone": "America/Belem",
            "past_days": 16,
            "forecast_days": 4,
            "daily": [
                "temperature_2m_max",
                "temperature_2m_mean",
                "precipitation_sum",
                "wind_speed_10m_max",
                "shortwave_radiation_sum",
                "et0_fao_evapotranspiration",
            ],
            "hourly": [
                "relative_humidity_2m",
                "dew_point_2m",
                "soil_moisture_0_to_1cm",
                "soil_moisture_1_to_3cm",
                "soil_moisture_3_to_9cm",
                "soil_moisture_9_to_27cm",
            ],
        }
        r = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=60)
        r.raise_for_status()
        js = r.json()

        df_d = pd.DataFrame(js["daily"]).rename(
            columns={
                "time": "data",
                "temperature_2m_max": "temp_max",
                "temperature_2m_mean": "temp_media",
                "precipitation_sum": "precipitacao_mm",
                "wind_speed_10m_max": "vento_max_kmh",
                "shortwave_radiation_sum": "radiacao_mj",
                "et0_fao_evapotranspiration": "et0_mm",
            }
        )
        df_h = adaptar_umidade_solo_forecast(pd.DataFrame(js["hourly"]))
        df_h["data"] = df_h["time"].str[:10]
        df_ha = df_h.groupby("data", as_index=False).agg(
            ur_min=("relative_humidity_2m", "min"),
            ur_media=("relative_humidity_2m", "mean"),
            temp_orvalho=("dew_point_2m", "mean"),
            umidade_solo_0_7=("umidade_solo_0_7", "mean"),
            umidade_solo_7_28=("umidade_solo_7_28", "mean"),
        )
        frames.append(df_d.merge(df_ha, on="data", how="left"))

    df_clima = pd.concat(frames, ignore_index=True).groupby("data", as_index=False).mean(numeric_only=True)
    return df_clima.sort_values("data").ffill().bfill().reset_index(drop=True)


def obter_focos_snpp_recentes(codigo_ibge: str, data_inicio: str) -> pd.DataFrame:
    """Agrega exclusivamente focos VIIRS S-NPP (paridade com o treino) no fuso America/Belem."""
    res = (
        sb.table("focos_incendio")
        .select("frp_mw, registado_em, confianca")
        .eq("codigo_ibge", codigo_ibge)
        .eq("satelite", "VIIRS_SNPP")
        .neq("confianca", "BAIXA")
        .gte("registado_em", f"{data_inicio}T00:00:00-03:00")
        .execute()
    )
    rows = res.data or []
    if not rows:
        return pd.DataFrame(columns=["data", "total_focos_snpp", "frp_total_snpp"])

    df = pd.DataFrame(rows)
    ts = pd.to_datetime(df["registado_em"], utc=True).dt.tz_convert(TZ_BELEM)
    df["data"] = ts.dt.strftime("%Y-%m-%d")
    df["frp_mw"] = pd.to_numeric(df["frp_mw"], errors="coerce").fillna(0.0)
    return df.groupby("data", as_index=False).agg(
        total_focos_snpp=("frp_mw", "count"),
        frp_total_snpp=("frp_mw", "sum"),
    )


def obter_estado_previo_nesterov(codigo_ibge: str, data_primeira_janela: str) -> tuple[float, int]:
    """Recupera Nesterov e Dry Spell do dia imediatamente anterior à janela, se existir."""
    dia_ant = (datetime.strptime(data_primeira_janela, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    res = (
        sb.table("serie_diaria_municipio")
        .select("nesterov_raw, dry_spell")
        .eq("codigo_ibge", codigo_ibge)
        .eq("data", dia_ant)
        .limit(1)
        .execute()
    )
    if res.data:
        return float(res.data[0]["nesterov_raw"]), int(res.data[0]["dry_spell"])
    return 0.0, 0


def classificar_risco(focos_d1: float, prob_crit_d1: float) -> str:
    if focos_d1 >= 15.0 or prob_crit_d1 >= 0.75:
        return "CRÍTICO"
    if focos_d1 >= 5.0 or prob_crit_d1 >= 0.50:
        return "ALTO"
    if focos_d1 >= 1.5 or prob_crit_d1 >= 0.25:
        return "MODERADO"
    return "BAIXO"


def enviar_alerta_telegram(codigo_ibge: str, payload: dict):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    if payload["nivel_risco"] not in ("ALTO", "CRÍTICO"):
        return

    icone = "🚨" if payload["nivel_risco"] == "CRÍTICO" else "⚠️"
    msg = (
        f"{icone} *CURUPIRA IA — ALERTA {payload['nivel_risco']}*\n"
        f"📍 Município: *{payload['municipio']}* (`{codigo_ibge}`)\n"
        f"📅 Referência: `{payload['data_referencia']}`\n\n"
        f"🔥 *Previsão 72h (VIIRS S-NPP):*\n"
        f"• D+1 (24h): *{payload['focos_previstos_d1']}* focos "
        f"(IC 95%: {payload['ic_inf_d1']}–{payload['ic_sup_d1']})\n"
        f"• D+2 (48h): *{payload['focos_previstos_d2']}* focos\n"
        f"• D+3 (72h): *{payload['focos_previstos_d3']}* focos\n"
        f"• Prob. Dia Crítico (≥5 focos): *{payload['prob_dia_critico_d1']*100:.1f}%*\n\n"
        f"🌡️ VPD: `{payload['vpd_kpa']} kPa` | Solo: `{payload['umidade_solo_pct']}%` | "
        f"Seca: `{payload['dias_sem_chuva']} dias`"
    )
    r = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        json={"chat_id": TELEGRAM_CHAT_ID, "text": msg, "parse_mode": "Markdown"},
        timeout=20,
    )
    if r.ok:
        sb.table("alertas_log").insert(
            {
                "codigo_ibge": codigo_ibge,
                "data_referencia": payload["data_referencia"],
                "nivel_risco": payload["nivel_risco"],
                "canal": "TELEGRAM",
                "destinatario": TELEGRAM_CHAT_ID,
                "mensagem": msg,
            }
        ).execute()


def main():
    print("🚀 Carregando Modelo Global Pará (CurupiraNet v2 — 3 sementes)...")
    meta = joblib.load(os.path.join(MODELS_DIR, "metadados_global_para.pkl"))
    modelos = [
        keras.models.load_model(os.path.join(MODELS_DIR, f"curupiranet_v2_global_para_seed{i}.keras"))
        for i in range(3)
    ]

    features_past = meta["features_past"]
    scaler_past = meta["scaler_past"]
    scaler_fut = meta["scaler_fut"]
    q_conf = np.array(meta["q_conf"], dtype=np.float32)
    eps_conf = float(meta["eps_conf"])
    log_clip_max = float(meta["log_clip_max"])

    # Dia-âncora t = ontem (dia fechado completo no fuso de Belém)
    hoje_belem = datetime.now(TZ_BELEM).date()
    data_ancora = (hoje_belem - timedelta(days=1)).strftime("%Y-%m-%d")
    datas_futuras = [
        (hoje_belem + timedelta(days=h)).strftime("%Y-%m-%d") for h in range(HORIZON)
    ]
    print(f"📅 Dia-âncora (fechado): {data_ancora} | Alvos D+1..D+3: {datas_futuras}")

    municipios = (
        sb.table("municipios_ibge")
        .select("codigo_ibge, nome, pontos_grade")
        .eq("ativo", True)
        .execute()
        .data
        or []
    )

    for mun in municipios:
        cod = mun["codigo_ibge"]
        nome = mun["nome"]
        pontos = mun["pontos_grade"]
        print(f"\n--- Processando {nome} ({cod}) ---")

        df_clima = coletar_clima_e_nwp(pontos)
        df_passado = df_clima[df_clima["data"] <= data_ancora].copy()
        df_futuro = df_clima[df_clima["data"].isin(datas_futuras)].sort_values("data").copy()

        if len(df_passado) < LOOKBACK or len(df_futuro) < HORIZON:
            print(f"⚠️ Janela insuficiente para {nome} (passado={len(df_passado)}, futuro={len(df_futuro)}).")
            continue

        # Junta focos VIIRS S-NPP do período passado
        df_focos = obter_focos_snpp_recentes(cod, df_passado["data"].iloc[0])
        df_passado = df_passado.merge(df_focos, on="data", how="left")
        df_passado["total_focos_snpp"] = df_passado["total_focos_snpp"].fillna(0).astype(int)
        df_passado["frp_total_snpp"] = df_passado["frp_total_snpp"].fillna(0.0)

        nest_ini, ds_ini = obter_estado_previo_nesterov(cod, df_passado["data"].iloc[0])
        df_feat = engenharia_biofisica(df_passado, nest_ini, ds_ini)

        # Persiste a série diária atualizada (mantém continuidade contínua de Nesterov/Dry Spell)
        upsert_serie = []
        for _, r in df_feat.iterrows():
            upsert_serie.append(
                {
                    "codigo_ibge": cod,
                    "data": str(r["data"]),
                    "total_focos_snpp": int(r["total_focos_snpp"]),
                    "frp_total_snpp": round(float(r["frp_total_snpp"]), 2),
                    "temp_max": round(float(r["temp_max"]), 2),
                    "temp_media": round(float(r["temp_media"]), 2),
                    "temp_orvalho": round(float(r["temp_orvalho"]), 2),
                    "ur_min": round(float(r["ur_min"]), 2),
                    "ur_media": round(float(r["ur_media"]), 2),
                    "precipitacao_mm": round(float(r["precipitacao_mm"]), 2),
                    "vento_max_kmh": round(float(r["vento_max_kmh"]), 2),
                    "radiacao_mj": round(float(r["radiacao_mj"]), 2),
                    "et0_mm": round(float(r["et0_mm"]), 2),
                    "umidade_solo_0_7": round(float(r["umidade_solo_0_7"]), 4),
                    "umidade_solo_7_28": round(float(r["umidade_solo_7_28"]), 4),
                    "nesterov_raw": round(float(r["nesterov_raw"]), 2),
                    "dry_spell": int(r["dry_spell"]),
                }
            )
        sb.table("serie_diaria_municipio").upsert(upsert_serie, on_conflict="codigo_ibge,data").execute()

        # Monta tensores de entrada (exatamente idênticos à Célula 9)
        janela = df_feat.tail(LOOKBACK)
        X_past_raw = janela[features_past].values.astype(np.float32)
        X_past_sc = scaler_past.transform(X_past_raw).astype(np.float32)

        X_seq = X_past_sc[np.newaxis, :, :]  # (1, 14, 22)
        X_last = X_past_sc[-1:, :]           # (1, 22)
        X_anchor = janela[["focos_log", "focos_ema3_log", "focos_ema7_log"]].iloc[-1:].values.astype(np.float32)

        # Contexto futuro NWP (3 passos x 9 atributos -> achatado em 27)
        dt_f = pd.to_datetime(df_futuro["data"])
        d_ano = dt_f.dt.dayofyear.values
        d_sem = dt_f.dt.dayofweek.values
        vpd_f = calcular_vpd(df_futuro["temp_max"].values, df_futuro["ur_min"].values)
        fut_raw = np.column_stack(
            [
                np.sin(2.0 * np.pi * d_ano / 365.25),
                np.cos(2.0 * np.pi * d_ano / 365.25),
                np.sin(2.0 * np.pi * d_sem / 7.0),
                np.cos(2.0 * np.pi * d_sem / 7.0),
                df_futuro["temp_max"].values,
                df_futuro["ur_min"].values,
                df_futuro["precipitacao_mm"].values,
                df_futuro["vento_max_kmh"].values,
                vpd_f,
            ]
        ).astype(np.float32)
        X_nwp = scaler_fut.transform(fut_raw).reshape(1, -1).astype(np.float32)

        # Inferência estocástica: 3 modelos x 10 passagens MC Dropout = 30 amostras
        inps_tf = [tf.constant(a) for a in (X_seq, X_last, X_anchor, X_nwp)]
        reg_samples, cls_samples = [], []
        for m in modelos:
            for _ in range(10):
                out = m(inps_tf, training=True)
                reg_samples.append(out["reg_out"].numpy()[0])
                cls_samples.append(out["cls_out"].numpy()[0])

        reg_st = np.stack(reg_samples, axis=0)
        mu_log = reg_st.mean(axis=0)
        sd_log = reg_st.std(axis=0)

        pred_raw = np.expm1(np.clip(mu_log, 0.0, log_clip_max))
        raio = q_conf * (sd_log + eps_conf)
        ic_inf = np.expm1(np.clip(mu_log - raio, 0.0, log_clip_max))
        ic_sup = np.expm1(np.clip(mu_log + raio, 0.0, log_clip_max))
        prob_cls = np.stack(cls_samples, axis=0).mean(axis=0)

        ult = df_feat.iloc[-1]
        risco = classificar_risco(float(pred_raw[0]), float(prob_cls[0]))

        payload = {
            "codigo_ibge": cod,
            "municipio": nome,
            "modelo_utilizado": "CurupiraNet_v2_GlobalPara_Conformal",
            "data_referencia": str(hoje_belem),
            "focos_previstos_d1": round(float(pred_raw[0]), 2),
            "focos_previstos_d2": round(float(pred_raw[1]), 2),
            "focos_previstos_d3": round(float(pred_raw[2]), 2),
            "ic_inf_d1": round(float(ic_inf[0]), 2),
            "ic_sup_d1": round(float(ic_sup[0]), 2),
            "ic_inf_d2": round(float(ic_inf[1]), 2),
            "ic_sup_d2": round(float(ic_sup[1]), 2),
            "ic_inf_d3": round(float(ic_inf[2]), 2),
            "ic_sup_d3": round(float(ic_sup[2]), 2),
            "prob_dia_critico_d1": round(float(prob_cls[0]), 4),
            "prob_dia_critico_d2": round(float(prob_cls[1]), 4),
            "prob_dia_critico_d3": round(float(prob_cls[2]), 4),
            "vpd_kpa": round(float(ult["vpd_kpa"]), 2),
            "indice_nesterov": round(float(ult["nesterov_raw"]), 2),
            "indice_angstrom": round(float(ult["indice_angstrom"]), 2),
            "umidade_solo_pct": round(float(ult["umidade_solo_0_7"] * 100.0), 2),
            "dias_sem_chuva": int(ult["dry_spell"]),
            "nivel_risco": risco,
            "xai_fatores": {
                "focos_ontem_snpp": int(ult["total_focos_snpp"]),
                "ur_min_prevista_d1": round(float(df_futuro["ur_min"].iloc[0]), 1),
                "chuva_prevista_72h_mm": round(float(df_futuro["precipitacao_mm"].sum()), 1),
                "fim_de_semana_d1": bool(d_sem[0] >= 4),
                "delta_solo_7d_pct": round(float(ult["delta_solo_7d"] * 100.0), 2),
            },
            "r2_validacao": 0.3830,
            "mae_validacao": 4.5130,
            "f1_validacao": 0.7200,
        }

        sb.table("previsoes_ia").upsert(payload, on_conflict="codigo_ibge,data_referencia").execute()
        enviar_alerta_telegram(cod, payload)
        print(
            f"   ✅ {nome}: D+1={payload['focos_previstos_d1']} "
            f"(IC95% {payload['ic_inf_d1']}–{payload['ic_sup_d1']}) | "
            f"ProbCrít={payload['prob_dia_critico_d1']*100:.1f}% | Risco={risco}"
        )

    print("\n🎉 Inferência diária concluída para todos os municípios ativos!")


if __name__ == "__main__":
    main()
