import { createServiceRoleClient } from '@/lib/utils/auth';
import { ValidationError, handleApiError } from '@/lib/utils/errors';
import { withCors, preflight } from '@/lib/utils/cors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(_request: Request, ctx: { params: { token: string } }) {
  try {
    const origin = _request.headers.get('origin');
    const token = ctx.params.token;
    if (!token) throw new ValidationError('Token is required');

    const supabase = createServiceRoleClient();

    const { data: invitation } = await supabase
      .from('employee_invitations')
      .select('*')
      .eq('token', token)
      .single();

    if (!invitation) {
      return withCors(origin, Response.json({ valid: false, error: 'Invalid token' }, { status: 404 }));
    }

    const nowIso = new Date().toISOString();
    if (invitation.status !== 'pending') {
      return withCors(origin, Response.json({ valid: false, error: 'Token not pending' }, { status: 400 }));
    }
    if (invitation.expires_at <= nowIso) {
      return withCors(origin, Response.json({ valid: false, error: 'Token expired' }, { status: 400 }));
    }

    const { data: employee } = await supabase
      .from('employees')
      .select('id, full_name, phone, business_id')
      .eq('id', invitation.employee_id)
      .single();

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', employee.business_id)
      .single();

    const { data: employeeBranches } = await supabase
      .from('employee_branches')
      .select('branch_id, status')
      .eq('employee_id', employee.id);

    const activeBranchIds = (employeeBranches || [])
      .filter((eb: any) => eb.status === 'active')
      .map((eb: any) => eb.branch_id);

    const { data: branches } = await supabase
      .from('branches')
      .select('name, address')
      .in('id', activeBranchIds.length ? activeBranchIds : ['00000000-0000-0000-0000-000000000000']);

    const res = {
      valid: true,
      employee: { full_name: employee.full_name, phone: employee.phone },
      business: { name: business.name },
      branches: branches || [],
      expires_at: invitation.expires_at,
    };
    return withCors(origin, Response.json(res));
  } catch (error) {
    return handleApiError(error);
  }
}







