import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

/**
 * DELETE /api/employees/[id]/invitation
 * Elimina todas las invitaciones pendientes de un empleado
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const employeeId = id;
    const supabase = createServiceRoleClient();

    // Verificar que el empleado existe y pertenece al negocio del usuario
    const { data: employee } = await supabase
      .from('employees')
      .select('id, business_id, full_name')
      .eq('id', employeeId)
      .single();
    
    if (!employee || employee.business_id !== businessId) {
      throw new NotFoundError('Employee');
    }

    // Obtener todas las invitaciones pendientes del empleado
    const { data: pendingInvitations } = await supabase
      .from('employee_invitations')
      .select('id, status')
      .eq('employee_id', employeeId)
      .eq('status', 'pending');

    if (!pendingInvitations || pendingInvitations.length === 0) {
      return withCors(origin, Response.json({ 
        message: 'No hay invitaciones pendientes para eliminar',
        deleted: 0
      }));
    }

    // Eliminar todas las invitaciones pendientes
    const { error: deleteError } = await supabase
      .from('employee_invitations')
      .delete()
      .eq('employee_id', employeeId)
      .eq('status', 'pending');

    if (deleteError) {
      console.error('Error al eliminar invitaciones:', deleteError);
      throw new Error(deleteError.message || 'Error al eliminar invitaciones');
    }

    console.log(`✅ [DELETE INVITATION] Se eliminaron ${pendingInvitations.length} invitación(es) pendiente(s) para el empleado ${employee.full_name} (${employeeId})`);

    return withCors(origin, Response.json({ 
      message: 'Invitaciones pendientes eliminadas exitosamente',
      deleted: pendingInvitations.length,
      employee_id: employeeId
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

