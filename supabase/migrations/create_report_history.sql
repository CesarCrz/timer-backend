-- Tabla para almacenar historial de reportes generados
CREATE TABLE IF NOT EXISTS public.report_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('business', 'branch', 'personal')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  branch_ids UUID[],
  branch_names TEXT[],
  employee_ids UUID[],
  employee_names TEXT[],
  format TEXT NOT NULL CHECK (format IN ('pdf', 'excel')),
  generated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_report_history_business ON public.report_history(business_id);
CREATE INDEX IF NOT EXISTS idx_report_history_generated_at ON public.report_history(generated_at DESC);

-- RLS
ALTER TABLE public.report_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own report history" ON public.report_history;
CREATE POLICY "Users can view own report history"
  ON public.report_history FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own report history" ON public.report_history;
CREATE POLICY "Users can insert own report history"
  ON public.report_history FOR INSERT
  WITH CHECK (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_id = auth.uid()
    )
  );

