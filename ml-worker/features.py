import numpy as np
import pandas as pd


def adaptar_umidade_solo_forecast(df_hourly: pd.DataFrame) -> pd.DataFrame:
    """
    Converte as camadas de umidade do solo do Open-Meteo Forecast (0-1, 1-3, 3-9, 9-27 cm)
    para a profundidade exata da reanálise ERA5-Land usada no treino (0-7 cm e 7-28 cm).
    """
    s01 = pd.to_numeric(df_hourly.get("soil_moisture_0_to_1cm"), errors="coerce")
    s13 = pd.to_numeric(df_hourly.get("soil_moisture_1_to_3cm"), errors="coerce")
    s39 = pd.to_numeric(df_hourly.get("soil_moisture_3_to_9cm"), errors="coerce")
    s927 = pd.to_numeric(df_hourly.get("soil_moisture_9_to_27cm"), errors="coerce")

    df_hourly = df_hourly.copy()
    df_hourly["umidade_solo_0_7"] = (1.0 / 7.0) * s01 + (2.0 / 7.0) * s13 + (4.0 / 7.0) * s39
    df_hourly["umidade_solo_7_28"] = s927
    return df_hourly


def calcular_vpd(temp_max: np.ndarray, ur_min: np.ndarray) -> np.ndarray:
    es = 0.61078 * np.exp((17.27 * temp_max) / (temp_max + 237.3))
    ea = es * (ur_min / 100.0)
    return np.maximum(0.0, es - ea)


def engenharia_biofisica(
    dataframe: pd.DataFrame,
    nesterov_inicial: float = 0.0,
    dry_spell_inicial: int = 0,
) -> pd.DataFrame:
    """
    Aplica a engenharia biofísica estritamente causal da CurupiraNet v2,
    preservando o estado acumulado de Nesterov e Dry Spell da série histórica.
    """
    d = dataframe.copy()
    d["data_dt"] = pd.to_datetime(d["data"])
    d = d.sort_values("data_dt").reset_index(drop=True)

    # 1. VPD (Equação de Tetens, kPa) e Angström (para painel da Defesa Civil)
    d["vpd_kpa"] = calcular_vpd(d["temp_max"].values, d["ur_min"].values)
    d["indice_angstrom"] = (d["ur_min"] / 20.0) + ((27.0 - d["temp_max"]) / 10.0)

    # 2. Índice Acumulado de Nesterov (G e ln(1+G)) com continuidade
    nesterov = np.zeros(len(d), dtype=float)
    tmax_arr = d["temp_max"].values
    torv_arr = d["temp_orvalho"].values
    prec_arr = d["precipitacao_mm"].values
    g_ant = float(nesterov_inicial)

    for i in range(len(d)):
        if prec_arr[i] < 2.5:
            g_atual = g_ant + tmax_arr[i] * max(0.0, tmax_arr[i] - torv_arr[i])
        else:
            g_atual = g_ant * max(0.0, 1.0 - (prec_arr[i] / 15.0))
        nesterov[i] = g_atual
        g_ant = g_atual

    d["nesterov_raw"] = nesterov
    d["nesterov_log"] = np.log1p(nesterov)

    # 3. Balanço Hídrico 14 dias e Dry Spell com continuidade
    d["balanco_hidrico_14d"] = (d["precipitacao_mm"] - d["et0_mm"]).rolling(14, min_periods=1).sum()
    dry_spell = np.zeros(len(d), dtype=int)
    ds_ant = int(dry_spell_inicial)
    for i in range(len(d)):
        ds_atual = (ds_ant + 1) if prec_arr[i] < 2.5 else 0
        dry_spell[i] = ds_atual
        ds_ant = ds_atual
    d["dry_spell"] = dry_spell

    # 4. Taxas de secagem
    d["delta_solo_7d"] = d["umidade_solo_0_7"] - d["umidade_solo_0_7"].shift(7).bfill()
    d["delta_vpd_3d"] = d["vpd_kpa"] - d["vpd_kpa"].shift(3).bfill()

    # 5. Ciclos sazonal e antrópico semanal
    dia_ano = d["data_dt"].dt.dayofyear
    d["sazonal_sin"] = np.sin(2.0 * np.pi * dia_ano / 365.25)
    d["sazonal_cos"] = np.cos(2.0 * np.pi * dia_ano / 365.25)
    dia_sem = d["data_dt"].dt.dayofweek
    d["semana_sin"] = np.sin(2.0 * np.pi * dia_sem / 7.0)
    d["semana_cos"] = np.cos(2.0 * np.pi * dia_sem / 7.0)

    # 6. Memória causal de focos e FRP (estritamente VIIRS S-NPP)
    d["focos_log"] = np.log1p(d["total_focos_snpp"])
    d["focos_ema3_log"] = d["focos_log"].ewm(span=3, adjust=False).mean()
    d["focos_ema7_log"] = d["focos_log"].ewm(span=7, adjust=False).mean()
    d["frp_log"] = np.log1p(d["frp_total_snpp"])
    d["frp_ema3_log"] = d["frp_log"].ewm(span=3, adjust=False).mean()

    return d
