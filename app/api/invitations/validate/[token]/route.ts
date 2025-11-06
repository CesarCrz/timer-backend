import { createServiceRoleClient } from '@/lib/utils/auth';
import { ValidationError, handleApiError } from '@/lib/utils/errors';
import { withCors, preflight } from '@/lib/utils/cors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> | { token: string } }) {
  try {
    const origin = _request.headers.get('origin');
    const params = await Promise.resolve(ctx.params);
    const token = params.token;
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

    if (!employee) {
      return withCors(origin, Response.json({ valid: false, error: 'Employee not found' }, { status: 404 }));
    }

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', employee.business_id)
      .single();

    if (!business) {
      return withCors(origin, Response.json({ valid: false, error: 'Business not found' }, { status: 404 }));
    }

    // Obtener branch_ids de la invitación (guardados como JSONB) o desde employee_branches existentes
    const branchIds = invitation.branch_ids || [];
    
    // Si no hay branch_ids en la invitación, intentar obtener desde employee_branches (para compatibilidad)
    let activeBranchIds = branchIds;
    if (branchIds.length === 0) {
      const { data: employeeBranches } = await supabase
        .from('employee_branches')
        .select('branch_id, status')
        .eq('employee_id', employee.id);

      activeBranchIds = (employeeBranches || [])
        .filter((eb: any) => eb.status === 'active')
        .map((eb: any) => eb.branch_id);
    }

    const { data: branches } = await supabase
      .from('branches')
      .select('name, address')
      .in('id', activeBranchIds.length > 0 ? activeBranchIds : ['00000000-0000-0000-0000-000000000000']);

    const res = {
      valid: true,
      invitation: {
        employee_name: employee.full_name,
        business_name: business.name,
        branches: branches || [],
        expires_at: invitation.expires_at,
      },
    };
    return withCors(origin, Response.json(res));
  } catch (error) {
    return handleApiError(error);
  }
}







