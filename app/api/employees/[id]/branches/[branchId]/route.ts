import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

/**
 * DELETE /api/employees/[id]/branches/[branchId]
 * Desactiva un empleado de una sucursal específica
 * Solo afecta a esa relación employee_branches, no al empleado en otras sucursales
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string; branchId: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id, branchId } = await ctx.params;
    const employeeId = id;

    const supabase = createServiceRoleClient();
    
    // Verificar que el empleado pertenece al negocio
    const { data: employee } = await supabase
      .from('employees')
      .select('id, business_id')
      .eq('id', employeeId)
      .single();
    if (!employee || employee.business_id !== businessId) throw new NotFoundError('Employee');

    // Verificar que la sucursal pertenece al negocio
    const { data: branch } = await supabase
      .from('branches')
      .select('id, business_id')
      .eq('id', branchId)
      .single();
    if (!branch || branch.business_id !== businessId) throw new NotFoundError('Branch');

    // Verificar que existe la relación
    const { data: employeeBranch } = await supabase
      .from('employee_branches')
      .select('id, status')
      .eq('employee_id', employeeId)
      .eq('branch_id', branchId)
      .single();
    
    if (!employeeBranch) {
      return withCors(origin, Response.json(
        { error: 'Employee is not assigned to this branch' },
        { status: 404 }
      ));
    }

    // Desactivar solo esta relación (no afecta otras sucursales)
    await supabase
      .from('employee_branches')
      .update({ status: 'inactive' })
      .eq('employee_id', employeeId)
      .eq('branch_id', branchId);

    return withCors(origin, Response.json({ 
      message: 'Employee deactivated from branch successfully', 
      employee_id: employeeId,
      branch_id: branchId
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

