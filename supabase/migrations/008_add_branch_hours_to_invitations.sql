-- Agregar campo branch_hours a employee_invitations para guardar horarios por sucursal
-- Este campo se usará para aplicar los horarios cuando el empleado acepte la invitación

ALTER TABLE public.employee_invitations
ADD COLUMN IF NOT EXISTS branch_hours JSONB;

COMMENT ON COLUMN public.employee_invitations.branch_hours IS 'Horarios específicos por sucursal: { "branchId": { "start": "HH:MM", "end": "HH:MM", "tolerance": number } }. Se aplicarán a employee_branches cuando el empleado acepte la invitación.';

