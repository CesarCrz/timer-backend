import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

const updateSchema = z.object({
  full_name: z.string().min(3).max(100).optional(),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
  hourly_rate: z.number().positive().max(10000).optional(),
  status: z.enum(['pending', 'active', 'inactive']).optional(),
  branch_ids: z.array(z.string().uuid()).optional(),
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

    if (branch_ids) {
      await supabase.from('employee_branches').delete().eq('employee_id', employeeId);
      if (branch_ids.length) {
        await supabase
          .from('employee_branches')
          .insert(branch_ids.map((bid) => ({ employee_id: employeeId, branch_id: bid, status: 'active' })));
      }
    }

    return withCors(origin, Response.json(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

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
    if (!existing || existing.business_id !== businessId) throw new NotFoundError('Employee');

    await supabase.from('employees').update({ status: 'inactive' }).eq('id', employeeId);
    return withCors(origin, Response.json({ message: 'Employee deactivated successfully', id: employeeId }));
  } catch (error) {
    return handleApiError(error);
  }
}



