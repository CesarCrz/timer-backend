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
    let token = params.token;
    if (!token) throw new ValidationError('Token is required');
    
    // Decodificar la URL en caso de que Meta haya codificado {{1}} como %7B%7B1%7D%7D
    try {
      token = decodeURIComponent(token);
    } catch (e) {
      // Si falla la decodificación, usar el token original
    }
    
    // Si el token incluye {{1}} o %7B%7B1%7D%7D (Meta no reemplazó correctamente)
    // Extraer solo la parte del UUID que viene después
    if (token.includes('{{1}}') || token.includes('%7B%7B1%7D%7D')) {
      // Buscar el UUID directamente (formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
      const uuidMatch = token.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) {
        token = uuidMatch[1];
      } else {
        // Si no hay UUID, intentar extraer después de }} o %7D%7D
        const afterBraceMatch = token.match(/(?:\}\}|%7D%7D)(.+)$/);
        if (afterBraceMatch) {
          token = afterBraceMatch[1];
        }
      }
    }
    
    console.log(`🔍 [VALIDATE] Token recibido: ${params.token}`);
    console.log(`🔍 [VALIDATE] Token procesado: ${token}`);

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







