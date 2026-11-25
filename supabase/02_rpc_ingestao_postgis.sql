-- ============================================================================
-- RPC DE INGESTÃO GEOESPACIAL: RECORTA PELO POLÍGONO IBGE NATIVAMENTE NO POSTGIS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inserir_focos_filtrados(
  p_codigo_ibge text,
  p_municipio text,
  p_focos jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inseridos integer := 0;
BEGIN
  WITH entrada AS (
    SELECT
      (elem->>'lat')::double precision AS lat,
      (elem->>'lon')::double precision AS lon,
      NULLIF(elem->>'temperatura_k', '')::numeric(6,2) AS temperatura_k,
      COALESCE(NULLIF(elem->>'frp_mw', '')::numeric(7,2), 0) AS frp_mw,
      COALESCE(elem->>'satelite', 'VIIRS_SNPP') AS satelite,
      COALESCE(elem->>'confianca', 'NOMINAL') AS confianca,
      COALESCE(elem->>'origem', 'SATELITE_NASA') AS origem,
      (elem->>'registado_em')::timestamptz AS registado_em
    FROM jsonb_array_elements(p_focos) AS elem
  ),
  filtrados AS (
    SELECT e.*
    FROM entrada e
    JOIN public.municipios_ibge m
      ON m.codigo_ibge = p_codigo_ibge
    WHERE m.geom IS NOT NULL
      AND ST_Contains(m.geom, ST_SetSRID(ST_MakePoint(e.lon, e.lat), 4326))
  ),
  gravados AS (
    INSERT INTO public.focos_incendio (
      codigo_ibge, municipio, lat, lon, temperatura_k, frp_mw,
      satelite, confianca, origem, registado_em
    )
    SELECT
      p_codigo_ibge, p_municipio, lat, lon, temperatura_k, frp_mw,
      satelite, confianca, origem, registado_em
    FROM filtrados
    ON CONFLICT (lat, lon, registado_em) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inseridos FROM gravados;

  RETURN v_inseridos;
END;
$$;

-- Restringe execução estritamente à service_role (backend/workers)
REVOKE ALL ON FUNCTION public.inserir_focos_filtrados(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inserir_focos_filtrados(text, text, jsonb) TO service_role;