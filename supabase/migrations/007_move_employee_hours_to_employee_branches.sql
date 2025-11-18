-- Migración: Mover campos de horario específico de employees a employee_branches
-- Esto permite que cada empleado tenga diferentes horarios en diferentes sucursales

-- 1. Agregar campos de horario a employee_branches
ALTER TABLE public.employee_branches
ADD COLUMN IF NOT EXISTS employees_hours_start TIME,
ADD COLUMN IF NOT EXISTS employees_hours_end TIME,
ADD COLUMN IF NOT EXISTS tolerance_minutes INT DEFAULT 0;

COMMENT ON COLUMN public.employee_branches.employees_hours_start IS 'Hora de inicio de jornada laboral específica para el empleado en esta sucursal (HH:MM). Si es NULL, se usa el horario de la sucursal.';
COMMENT ON COLUMN public.employee_branches.employees_hours_end IS 'Hora de fin de jornada laboral específica para el empleado en esta sucursal (HH:MM). Si es NULL, se usa el horario de la sucursal.';
COMMENT ON COLUMN public.employee_branches.tolerance_minutes IS 'Minutos de tolerancia para la llegada tarde del empleado en esta sucursal (0-59). Si es NULL, se usa la tolerancia de la sucursal.';

-- 2. Migrar datos existentes de employees a employee_branches
-- Si un empleado tiene horario específico, copiarlo a todas sus sucursales activas
UPDATE public.employee_branches eb
SET 
  employees_hours_start = e.employees_hours_start,
  employees_hours_end = e.employees_hours_end,
  tolerance_minutes = COALESCE(e.tolerance_minutes, 0)
FROM public.employees e
WHERE eb.employee_id = e.id
  AND eb.status = 'active'
  AND e.employees_hours_start IS NOT NULL
  AND e.employees_hours_end IS NOT NULL;

-- 3. Eliminar campos de horario de employees (ya no se necesitan)
ALTER TABLE public.employees
DROP COLUMN IF EXISTS employees_hours_start,
DROP COLUMN IF EXISTS employees_hours_end,
DROP COLUMN IF EXISTS tolerance_minutes;

