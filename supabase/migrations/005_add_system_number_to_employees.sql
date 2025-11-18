-- Migration: Add system_number_registered to employees table
-- This field stores which WhatsApp number the employee should use

ALTER TABLE public.employees
ADD COLUMN IF NOT EXISTS system_number_registered TEXT;

-- Add foreign key reference to system_numbers (optional, can be null)
-- Note: We use TEXT instead of UUID because we want to store the number directly
-- and allow flexibility in case numbers are added/removed
-- Use DO block to check if constraint exists before adding
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_employees_system_number'
  ) THEN
    ALTER TABLE public.employees
    ADD CONSTRAINT fk_employees_system_number 
    FOREIGN KEY (system_number_registered) 
    REFERENCES public.system_numbers(number) 
    ON DELETE SET NULL;
  END IF;
END $$;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_employees_system_number ON public.employees(system_number_registered);

-- Add comment
COMMENT ON COLUMN public.employees.system_number_registered IS 'Número de WhatsApp del sistema asignado al empleado (ej: 5213310969584). El empleado debe enviar su ubicación a este número.';

