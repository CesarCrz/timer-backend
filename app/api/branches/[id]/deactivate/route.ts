import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

/**
 * PUT /api/branches/[id]/deactivate
 * Desactiva una sucursal (soft delete)
 * Cambia el status a 'inactive' y desactiva automáticamente los empleados de esta sucursal
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const branchId = id;
    const supabase = createServiceRoleClient();

    const { data: existing } = await supabase
      .from('branches')
      .select('id, business_id, status')
      .eq('id', branchId)
      .single();
    
    if (!existing || existing.business_id !== businessId) {
      throw new NotFoundError('Branch');
    }

    if (existing.status === 'inactive') {
      return withCors(origin, Response.json(
        { error: 'La sucursal ya está desactivada' },
        { status: 400 }
      ));
    }

    // Desactivar la sucursal (el trigger automáticamente desactivará employee_branches)
    await supabase
      .from('branches')
      .update({ status: 'inactive' })
      .eq('id', branchId);

    return withCors(origin, Response.json({ 
      message: 'Branch deactivated successfully', 
      id: branchId 
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

