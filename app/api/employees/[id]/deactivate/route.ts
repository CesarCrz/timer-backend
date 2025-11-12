import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

/**
 * PUT /api/employees/[id]/deactivate
 * Desactiva un empleado (soft delete)
 * Cambia el status a 'inactive' y desactiva todas sus relaciones con sucursales
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const employeeId = id;
    const supabase = createServiceRoleClient();

    const { data: existing } = await supabase
      .from('employees')
      .select('id, business_id, status')
      .eq('id', employeeId)
      .single();
    
    if (!existing || existing.business_id !== businessId) {
      throw new NotFoundError('Employee');
    }

    if (existing.status === 'inactive') {
      return withCors(origin, Response.json(
        { error: 'El empleado ya está desactivado' },
        { status: 400 }
      ));
    }

    // Desactivar empleado (afecta a TODAS las sucursales)
    await supabase
      .from('employees')
      .update({ status: 'inactive' })
      .eq('id', employeeId);
    
    // Desactivar todas las relaciones employee_branches para este empleado
    await supabase
      .from('employee_branches')
      .update({ status: 'inactive' })
      .eq('employee_id', employeeId)
      .eq('status', 'active');
    
    return withCors(origin, Response.json({ 
      message: 'Employee deactivated successfully in all branches', 
      id: employeeId 
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

