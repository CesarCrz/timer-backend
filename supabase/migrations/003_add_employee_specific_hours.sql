-- Migration: Add employee-specific work hours (Premium feature)
-- This allows premium users to set specific work hours for each employee

-- Add columns to employees table
ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS employees_hours_start TIME,
ADD COLUMN IF NOT EXISTS employees_hours_end TIME,
ADD COLUMN IF NOT EXISTS tolerance_minutes INT DEFAULT 0 CHECK (tolerance_minutes >= 0 AND tolerance_minutes <= 59);

-- Add comment to explain the columns
COMMENT ON COLUMN public.employees.employees_hours_start IS 'Hora de inicio específica del empleado (solo para usuarios premium). Si es NULL, usa el horario de la sucursal.';
COMMENT ON COLUMN public.employees.employees_hours_end IS 'Hora de fin específica del empleado (solo para usuarios premium). Si es NULL, usa el horario de la sucursal.';
COMMENT ON COLUMN public.employees.tolerance_minutes IS 'Tolerancia en minutos para el empleado (1-59). Solo para usuarios premium.';

