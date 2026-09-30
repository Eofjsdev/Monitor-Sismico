-- SISMO·MONITOR (mundial) — ejecutar en Supabase → SQL Editor

CREATE TABLE IF NOT EXISTS public.sismos (
  id TEXT PRIMARY KEY,
  fuente TEXT NOT NULL,
  fecha_hora_utc TIMESTAMPTZ NOT NULL,
  magnitud NUMERIC(3,1) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  profundidad_km NUMERIC(5,1) DEFAULT 0,
  lugar TEXT NOT NULL DEFAULT '—',
  pais TEXT,
  tsunami BOOLEAN DEFAULT FALSE,
  pager TEXT,
  felt INTEGER,
  url TEXT,
  registrado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sismos_fecha_hora ON public.sismos (fecha_hora_utc DESC);
CREATE INDEX IF NOT EXISTS idx_sismos_mag ON public.sismos (magnitud);
CREATE INDEX IF NOT EXISTS idx_sismos_fuente ON public.sismos (fuente);
CREATE INDEX IF NOT EXISTS idx_sismos_lat_lon ON public.sismos (lat, lon);

CREATE TABLE IF NOT EXISTS public.telegram_publicados (
  id TEXT PRIMARY KEY,
  sismo_id TEXT REFERENCES public.sismos(id) ON DELETE SET NULL,
  fecha_hora_utc TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  magnitud NUMERIC(3,1) NOT NULL,
  enviado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telegram_pub_fecha ON public.telegram_publicados (fecha_hora_utc DESC);

CREATE TABLE IF NOT EXISTS public.reportes_sentidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sismo_id TEXT NOT NULL REFERENCES public.sismos(id) ON DELETE CASCADE,
  intensidad TEXT NOT NULL,
  intensidad_mmi INTEGER NOT NULL DEFAULT 2,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  ciudad TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reportes_sismo_id ON public.reportes_sentidos (sismo_id);
CREATE INDEX IF NOT EXISTS idx_reportes_fecha ON public.reportes_sentidos (created_at DESC);

-- Seguridad: el público solo lee sismos y crea/lee reportes.
-- Escribir en sismos y telegram_publicados solo lo hace la Edge Function (service_role, ignora RLS).
ALTER TABLE public.sismos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reportes_sentidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_publicados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Lectura pública de sismos" ON public.sismos;
CREATE POLICY "Lectura pública de sismos" ON public.sismos
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Crear reportes sentidos" ON public.reportes_sentidos;
CREATE POLICY "Crear reportes sentidos" ON public.reportes_sentidos
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Lectura pública de reportes sentidos" ON public.reportes_sentidos;
CREATE POLICY "Lectura pública de reportes sentidos" ON public.reportes_sentidos
  FOR SELECT TO anon, authenticated USING (true);

-- Realtime
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.sismos;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.reportes_sentidos;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
