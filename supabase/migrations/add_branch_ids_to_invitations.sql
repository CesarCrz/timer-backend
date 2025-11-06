-- Migration: Add branch_ids column to employee_invitations table
-- This allows storing the branches that an employee was invited to join
-- The branches will be created in employee_branches only when the employee accepts the invitation

ALTER TABLE public.employee_invitations
ADD COLUMN IF NOT EXISTS branch_ids JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.employee_invitations.branch_ids IS 'Array of branch IDs that the employee was invited to join. These will be created in employee_branches when the invitation is accepted.';

