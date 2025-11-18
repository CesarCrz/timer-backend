-- Migration: Create system_numbers table for WhatsApp number distribution
-- This table stores multiple WhatsApp numbers to distribute load

CREATE TABLE IF NOT EXISTS public.system_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL UNIQUE, -- e.g., "5213310969584" (without +)
  meta_jwt_token TEXT NOT NULL,
  meta_number_id TEXT NOT NULL,
  meta_verify_token TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  max_employees INT DEFAULT 100, -- Maximum employees per number
  current_employees_count INT DEFAULT 0, -- Current count (updated by trigger or application logic)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index for active numbers
CREATE INDEX IF NOT EXISTS idx_system_numbers_active ON public.system_numbers(is_active) WHERE is_active = true;

-- Add comment
COMMENT ON TABLE public.system_numbers IS 'Almacena los números de WhatsApp del sistema para distribución de carga';
COMMENT ON COLUMN public.system_numbers.number IS 'Número de teléfono sin el signo + (ej: 5213310969584)';
COMMENT ON COLUMN public.system_numbers.max_employees IS 'Máximo de empleados asignados a este número';
COMMENT ON COLUMN public.system_numbers.current_employees_count IS 'Cantidad actual de empleados asignados (se actualiza automáticamente)';

-- RLS: Only service role can access (no user access needed)
ALTER TABLE public.system_numbers ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role can manage system_numbers"
  ON public.system_numbers
  FOR ALL
  USING (true)
  WITH CHECK (true);

