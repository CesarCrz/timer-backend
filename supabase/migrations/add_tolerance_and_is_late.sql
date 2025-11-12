-- Agregar campo tolerance_minutes a branches (0-59 minutos)
ALTER TABLE public.branches 
ADD COLUMN IF NOT EXISTS tolerance_minutes INTEGER DEFAULT 0 CHECK (tolerance_minutes >= 0 AND tolerance_minutes <= 59);

-- Agregar campo is_late a attendance_records
ALTER TABLE public.attendance_records 
ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT false;

-- Crear índice para mejorar consultas de llegadas tarde
CREATE INDEX IF NOT EXISTS idx_attendance_is_late ON public.attendance_records(is_late);

