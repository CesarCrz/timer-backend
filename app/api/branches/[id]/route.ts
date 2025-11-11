import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

const updateSchema = z.object({
  name: z.string().min(3).max(50).optional(),
  address: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  tolerance_radius_meters: z.number().min(10).max(200).optional(),
  timezone: z.string().optional(),
  business_hours_start: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  business_hours_end: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  status: z.enum(['active', 'inactive']).optional(),
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
    const branchId = ctx.params.id;
    const body = await request.json();
    const updates = updateSchema.parse(body);

    const supabase = createServiceRoleClient();
    const { data: existing } = await supabase
      .from('branches')
      .select('id, business_id')
      .eq('id', branchId)
      .single();

    if (!existing || existing.business_id !== businessId) throw new NotFoundError('Branch');

    const { data: updated } = await supabase
      .from('branches')
      .update(updates)
      .eq('id', branchId)
      .select()
      .single();

    return withCors(origin, Response.json(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/branches/[id]
 * Elimina permanentemente una sucursal (hard delete)
 * ⚠️ Esta acción es irreversible y eliminará todos los registros relacionados
 */
export async function DELETE(request: Request, ctx: { params: { id: string } }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const branchId = ctx.params.id;
    const supabase = createServiceRoleClient();

    const { data: existing } = await supabase
      .from('branches')
      .select('id, business_id')
      .eq('id', branchId)
      .single();
    
    if (!existing || existing.business_id !== businessId) {
      throw new NotFoundError('Branch');
    }

    // Eliminar permanentemente la sucursal
    // Las relaciones employee_branches se eliminarán automáticamente por CASCADE
    // Los registros de asistencia (attendance_records) también se eliminarán por CASCADE
    await supabase
      .from('branches')
      .delete()
      .eq('id', branchId);

    return withCors(origin, Response.json({ 
      message: 'Branch deleted permanently', 
      id: branchId 
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







