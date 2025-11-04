import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { ValidationError, handleApiError } from '@/lib/utils/errors';
import { withCors, preflight } from '@/lib/utils/cors';

const acceptSchema = z.object({
  token: z.string().uuid(),
  terms_accepted: z.literal(true),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const body = await request.json();
    const { token } = acceptSchema.parse(body);

    const supabase = createServiceRoleClient();
    const nowIso = new Date().toISOString();

    const { data: invitation } = await supabase
      .from('employee_invitations')
      .select('*')
      .eq('token', token)
      .single();

    if (!invitation) throw new ValidationError('Invalid token');
    if (invitation.status !== 'pending') throw new ValidationError('Token not pending');
    if (invitation.expires_at <= nowIso) throw new ValidationError('Token expired');

    const { data: employee } = await supabase
      .from('employees')
      .select('id')
      .eq('id', invitation.employee_id)
      .single();

    await supabase
      .from('employees')
      .update({ status: 'active', terms_accepted_at: nowIso })
      .eq('id', employee.id);

    await supabase
      .from('employee_invitations')
      .update({ status: 'accepted' })
      .eq('id', invitation.id);

    return withCors(origin, Response.json({ message: 'Invitation accepted successfully', employee_id: employee.id }));
  } catch (error) {
    return handleApiError(error);
  }
}







