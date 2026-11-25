-- ============================================================================
-- PROJETO CURUPIRA IA — SCHEMA MULTI-TENANT (POSTGRESQL + POSTGIS + RLS)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. CADASTRO DE MUNICÍPIOS CONTRATANTES (MALHA OFICIAL IBGE)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.municipios_ibge (
  codigo_ibge text PRIMARY KEY,
  nome text NOT NULL,
  uf text NOT NULL DEFAULT 'PA',
  geom geometry(MultiPolygon, 4326),
  bbox_w double precision,
  bbox_s double precision,
  bbox_e double precision,
  bbox_n double precision,
  pontos_grade jsonb NOT NULL DEFAULT '[]'::jsonb, -- Lista [[lat, lon], ...] para ERA5/Forecast
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_municipios_geom
  ON public.municipios_ibge USING GIST (geom);

-- ----------------------------------------------------------------------------
-- 2. CAMADAS FUNDIÁRIAS E AMBIENTAIS (CAR / UC / TI / QUILOMBOLA)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.camadas_fundiarias (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo_ibge text NOT NULL REFERENCES public.municipios_ibge(codigo_ibge) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('CAR', 'UC', 'TI', 'QUILOMBOLA', 'APP')),
  nome text NOT NULL,
  codigo_oficial text,
  geom geometry(MultiPolygon, 4326) NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_fundiarias_geom
  ON public.camadas_fundiarias USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_fundiarias_ibge
  ON public.camadas_fundiarias (codigo_ibge, tipo);

-- ----------------------------------------------------------------------------
-- 3. PERFIS DE USUÁRIO E CONTROLE DE ACESSO (RBAC MULTI-PREFEITURA)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.perfis_usuario (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  codigo_ibge text REFERENCES public.municipios_ibge(codigo_ibge),
  nome_completo text NOT NULL,
  cargo text,
  role text NOT NULL CHECK (role IN ('super_admin', 'gestor_prefeitura', 'brigadista', 'auditor_leitura')),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- Funções auxiliares para políticas RLS sem recursão
CREATE OR REPLACE FUNCTION public.meu_codigo_ibge()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT codigo_ibge FROM public.perfis_usuario WHERE user_id = auth.uid() AND ativo = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.minha_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.perfis_usuario WHERE user_id = auth.uid() AND ativo = true LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.eh_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT role = 'super_admin' FROM public.perfis_usuario WHERE user_id = auth.uid() AND ativo = true), false);
$$;

-- ----------------------------------------------------------------------------
-- 4. FOCOS DE INCÊNDIO (SATÉLITES NASA/INPE + OCORRÊNCIAS CAMPO_BRIGADA)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.focos_incendio (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo_ibge text NOT NULL REFERENCES public.municipios_ibge(codigo_ibge),
  municipio text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED,
  temperatura_k numeric(6,2),
  frp_mw numeric(7,2) DEFAULT 0,
  satelite text NOT NULL DEFAULT 'VIIRS_SNPP', -- 'VIIRS_SNPP', 'VIIRS_NOAA20', 'VIIRS_NOAA21', 'CAMPO_BRIGADA'
  confianca text NOT NULL DEFAULT 'ALTA',      -- 'BAIXA', 'NOMINAL', 'ALTA'
  origem text NOT NULL CHECK (origem IN ('SATELITE_NASA', 'SATELITE_INPE', 'CAMPO_BRIGADA')),
  status_combate text NOT NULL DEFAULT 'ATIVO' CHECK (status_combate IN ('ATIVO', 'EM_COMBATE', 'CONTROLADO', 'FALSO_POSITIVO')),
  jurisdicao_tipo text, -- Preenchido automaticamente pelo trigger PostGIS (CAR, UC, TI, QUILOMBOLA)
  jurisdicao_nome text,
  local_referencia text,
  porte text DEFAULT 'Monitoramento',
  observacoes text,
  criado_por uuid REFERENCES auth.users(id),
  registado_em timestamptz NOT NULL DEFAULT timezone('utc', now()),
  criado_em timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (lat, lon, registado_em)
);

CREATE INDEX IF NOT EXISTS idx_focos_geom ON public.focos_incendio USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_focos_ibge_data ON public.focos_incendio (codigo_ibge, registado_em DESC);
CREATE INDEX IF NOT EXISTS idx_focos_satelite ON public.focos_incendio (codigo_ibge, satelite, registado_em DESC);

-- Trigger PostGIS: etiqueta automaticamente o foco se cair dentro de TI, UC, Quilombola ou CAR
CREATE OR REPLACE FUNCTION public.etiquetar_jurisdicao_foco()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tipo text;
  v_nome text;
  v_pt geometry(Point, 4326);
BEGIN
  v_pt := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326);

  SELECT cf.tipo, cf.nome
    INTO v_tipo, v_nome
  FROM public.camadas_fundiarias cf
  WHERE cf.codigo_ibge = NEW.codigo_ibge
    AND ST_Intersects(cf.geom, v_pt)
  ORDER BY CASE cf.tipo
    WHEN 'TI' THEN 1
    WHEN 'UC' THEN 2
    WHEN 'QUILOMBOLA' THEN 3
    WHEN 'APP' THEN 4
    ELSE 5
  END
  LIMIT 1;

  IF v_tipo IS NOT NULL THEN
    NEW.jurisdicao_tipo := v_tipo;
    NEW.jurisdicao_nome := v_nome;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_etiquetar_jurisdicao_foco ON public.focos_incendio;
CREATE TRIGGER trg_etiquetar_jurisdicao_foco
  BEFORE INSERT OR UPDATE OF lat, lon ON public.focos_incendio
  FOR EACH ROW
  EXECUTE FUNCTION public.etiquetar_jurisdicao_foco();

-- ----------------------------------------------------------------------------
-- 5. SÉRIE DIÁRIA CONSOLIDADA POR MUNICÍPIO (MEMÓRIA CONTÍNUA DE NESTEROV/SOLO)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.serie_diaria_municipio (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  codigo_ibge text NOT NULL REFERENCES public.municipios_ibge(codigo_ibge),
  data date NOT NULL,
  total_focos_snpp integer NOT NULL DEFAULT 0, -- ESTRITAMENTE sensor único VIIRS S-NPP (paridade treino)
  frp_total_snpp numeric(10,2) NOT NULL DEFAULT 0,
  temp_max numeric(5,2),
  temp_media numeric(5,2),
  temp_orvalho numeric(5,2),
  ur_min numeric(5,2),
  ur_media numeric(5,2),
  precipitacao_mm numeric(7,2),
  vento_max_kmh numeric(6,2),
  radiacao_mj numeric(6,2),
  et0_mm numeric(6,2),
  umidade_solo_0_7 numeric(6,4),
  umidade_solo_7_28 numeric(6,4),
  nesterov_raw numeric(10,2) NOT NULL DEFAULT 0,
  dry_spell integer NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (codigo_ibge, data)
);

CREATE INDEX IF NOT EXISTS idx_serie_ibge_data
  ON public.serie_diaria_municipio (codigo_ibge, data DESC);

-- ----------------------------------------------------------------------------
-- 6. BOLETINS PREDITIVOS MULTI-HORIZONTE (CURUPIRANET v2 + CONFORMAL 95%)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.previsoes_ia (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  codigo_ibge text NOT NULL REFERENCES public.municipios_ibge(codigo_ibge),
  municipio text NOT NULL,
  modelo_utilizado text NOT NULL DEFAULT 'CurupiraNet_v2_GlobalPara_Conformal',
  data_referencia date NOT NULL,
  focos_previstos_d1 numeric(7,2) NOT NULL,
  focos_previstos_d2 numeric(7,2) NOT NULL,
  focos_previstos_d3 numeric(7,2) NOT NULL,
  ic_inf_d1 numeric(7,2) DEFAULT 0,
  ic_sup_d1 numeric(7,2) DEFAULT 0,
  ic_inf_d2 numeric(7,2) DEFAULT 0,
  ic_sup_d2 numeric(7,2) DEFAULT 0,
  ic_inf_d3 numeric(7,2) DEFAULT 0,
  ic_sup_d3 numeric(7,2) DEFAULT 0,
  prob_dia_critico_d1 numeric(5,4) DEFAULT 0,
  prob_dia_critico_d2 numeric(5,4) DEFAULT 0,
  prob_dia_critico_d3 numeric(5,4) DEFAULT 0,
  vpd_kpa numeric(5,2),
  indice_nesterov numeric(10,2),
  indice_angstrom numeric(5,2),
  umidade_solo_pct numeric(5,2),
  dias_sem_chuva integer DEFAULT 0,
  nivel_risco text NOT NULL CHECK (nivel_risco IN ('BAIXO', 'MODERADO', 'ALTO', 'CRÍTICO')),
  xai_fatores jsonb DEFAULT '{}'::jsonb,
  r2_validacao numeric(5,4) DEFAULT 0.3830,
  mae_validacao numeric(6,4) DEFAULT 4.5130,
  f1_validacao numeric(5,4) DEFAULT 0.7200,
  atualizado_em timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (codigo_ibge, data_referencia)
);

CREATE INDEX IF NOT EXISTS idx_previsoes_ibge_data
  ON public.previsoes_ia (codigo_ibge, data_referencia DESC);

-- ----------------------------------------------------------------------------
-- 7. LOG DE AUDITORIA DE ALERTAS ENVIADOS (DEFESA CIVIL / SEMMA)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alertas_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo_ibge text NOT NULL REFERENCES public.municipios_ibge(codigo_ibge),
  data_referencia date NOT NULL,
  nivel_risco text NOT NULL,
  canal text NOT NULL, -- 'TELEGRAM', 'WHATSAPP', 'EMAIL'
  destinatario text,
  mensagem text NOT NULL,
  enviado_em timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 8. ROW-LEVEL SECURITY (ISOLAMENTO RIGOROSO POR PREFEITURA)
-- ----------------------------------------------------------------------------
ALTER TABLE public.municipios_ibge ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camadas_fundiarias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perfis_usuario ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focos_incendio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serie_diaria_municipio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.previsoes_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alertas_log ENABLE ROW LEVEL SECURITY;

-- Municípios: leitura permitida para o próprio município (ou super_admin)
CREATE POLICY "mun_select" ON public.municipios_ibge FOR SELECT TO authenticated
  USING (public.eh_super_admin() OR codigo_ibge = public.meu_codigo_ibge());

-- Perfis: usuário lê o próprio perfil; gestor lê brigadistas da sua cidade; super_admin lê todos
CREATE POLICY "perfil_select" ON public.perfis_usuario FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.eh_super_admin()
    OR (public.minha_role() = 'gestor_prefeitura' AND codigo_ibge = public.meu_codigo_ibge())
  );

-- Focos: leitura isolada por município
CREATE POLICY "focos_select" ON public.focos_incendio FOR SELECT TO authenticated
  USING (public.eh_super_admin() OR codigo_ibge = public.meu_codigo_ibge());

-- Focos: brigadistas e gestores podem registrar ocorrências CAMPO_BRIGADA no seu município
CREATE POLICY "focos_insert_campo" ON public.focos_incendio FOR INSERT TO authenticated
  WITH CHECK (
    (public.eh_super_admin() OR (codigo_ibge = public.meu_codigo_ibge() AND public.minha_role() IN ('gestor_prefeitura', 'brigadista')))
    AND origem = 'CAMPO_BRIGADA'
  );

-- Focos: brigadistas e gestores podem atualizar status de combate no seu município
CREATE POLICY "focos_update_status" ON public.focos_incendio FOR UPDATE TO authenticated
  USING (public.eh_super_admin() OR (codigo_ibge = public.meu_codigo_ibge() AND public.minha_role() IN ('gestor_prefeitura', 'brigadista')))
  WITH CHECK (public.eh_super_admin() OR (codigo_ibge = public.meu_codigo_ibge() AND public.minha_role() IN ('gestor_prefeitura', 'brigadista')));

-- Série diária, previsões IA, camadas fundiárias e alertas: leitura isolada por município
CREATE POLICY "serie_select" ON public.serie_diaria_municipio FOR SELECT TO authenticated
  USING (public.eh_super_admin() OR codigo_ibge = public.meu_codigo_ibge());

CREATE POLICY "previsoes_select" ON public.previsoes_ia FOR SELECT TO authenticated
  USING (public.eh_super_admin() OR codigo_ibge = public.meu_codigo_ibge());

CREATE POLICY "fundiarias_select" ON public.camadas_fundiarias FOR SELECT TO authenticated
  USING (public.eh_super_admin() OR codigo_ibge = public.meu_codigo_ibge());

CREATE POLICY "alertas_select" ON public.alertas_log FOR SELECT TO authenticated
  USING (public.eh_super_admin() OR codigo_ibge = public.meu_codigo_ibge());

-- ----------------------------------------------------------------------------
-- 9. HABILITAÇÃO DO SUPABASE REALTIME (SINCRONIZAÇÃO AO VIVO NO PWA)
-- ----------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.focos_incendio;
ALTER PUBLICATION supabase_realtime ADD TABLE public.previsoes_ia;