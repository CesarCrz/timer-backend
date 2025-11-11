import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

const updateSchema = z.object({
  full_name: z.string().min(3).max(100).optional(),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
  hourly_rate: z.number().positive().max(10000).optional(),
  status: z.enum(['pending', 'active', 'inactive']).optional(),
  branch_ids: z.array(z.string().uuid()).optional(), // Permite array vacío para desactivar de todas las sucursales
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function PUT(request: Request, ctx: { params: { id: string } }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const employeeId = ctx.params.id;
    const body = await request.json();
    const updates = updateSchema.parse(body);

    const supabase = createServiceRoleClient();
    const { data: existing } = await supabase
      .from('employees')
      .select('id, business_id')
      .eq('id', employeeId)
      .single();
    if (!existing || existing.business_id !== businessId) throw new NotFoundError('Employee');

    const { branch_ids, ...empUpdates } = updates;
    const { data: updated } = await supabase
      .from('employees')
      .update(empUpdates)
      .eq('id', employeeId)
      .select()
      .single();

    if (branch_ids !== undefined) {
      // Obtener todas las relaciones actuales del empleado
      const { data: currentBranches } = await supabase
        .from('employee_branches')
        .select('branch_id, status')
        .eq('employee_id', employeeId);

      const currentBranchIds = currentBranches?.map(eb => eb.branch_id) || [];
      const newBranchIds = branch_ids || [];

      // Sucursales a desactivar (estaban activas pero ya no están en la lista)
      const branchesToDeactivate = currentBranchIds.filter(bid => !newBranchIds.includes(bid));
      if (branchesToDeactivate.length > 0) {
        await supabase
          .from('employee_branches')
          .update({ status: 'inactive' })
          .eq('employee_id', employeeId)
          .in('branch_id', branchesToDeactivate);
      }

      // Sucursales a activar/reactivar (están en la nueva lista)
      const branchesToActivate = newBranchIds.filter(bid => !currentBranchIds.includes(bid));
      if (branchesToActivate.length > 0) {
        // Verificar si ya existen relaciones inactivas para reactivarlas
        const { data: existingInactive } = await supabase
          .from('employee_branches')
          .select('branch_id')
          .eq('employee_id', employeeId)
          .in('branch_id', branchesToActivate)
          .eq('status', 'inactive');

        const existingInactiveIds = existingInactive?.map(eb => eb.branch_id) || [];
        const toReactivate = branchesToActivate.filter(bid => existingInactiveIds.includes(bid));
        const toInsert = branchesToActivate.filter(bid => !existingInactiveIds.includes(bid));

        // Reactivar relaciones existentes
        if (toReactivate.length > 0) {
          await supabase
            .from('employee_branches')
            .update({ status: 'active' })
            .eq('employee_id', employeeId)
            .in('branch_id', toReactivate);
        }

        // Insertar nuevas relaciones
        if (toInsert.length > 0) {
          await supabase
            .from('employee_branches')
            .insert(toInsert.map((bid) => ({ employee_id: employeeId, branch_id: bid, status: 'active' })));
        }
      }
    }

    return withCors(origin, Response.json(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/employees/[id]
 * Elimina permanentemente un empleado (hard delete)
 * ⚠️ Esta acción es irreversible y eliminará todos los registros relacionados
 */
export async function DELETE(request: Request, ctx: { params: { id: string } }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const employeeId = ctx.params.id;

    const supabase = createServiceRoleClient();
    const { data: existing } = await supabase
      .from('employees')
      .select('id, business_id')
      .eq('id', employeeId)
      .single();
    
    if (!existing || existing.business_id !== businessId) {
      throw new NotFoundError('Employee');
    }

    // Eliminar permanentemente el empleado
    // Las relaciones employee_branches se eliminarán automáticamente por CASCADE
    // Los registros de asistencia (attendance_records) también se eliminarán por CASCADE
    // Las invitaciones (employee_invitations) también se eliminarán por CASCADE
    await supabase
      .from('employees')
      .delete()
      .eq('id', employeeId);
    
    return withCors(origin, Response.json({ 
      message: 'Employee deleted permanently', 
      id: employeeId 
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







