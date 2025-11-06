import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request, ctx: { params: { id: string } }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const employeeId = ctx.params.id;
    const supabase = createServiceRoleClient();

    const { data: employee } = await supabase
      .from('employees')
      .select('id, business_id, full_name, phone')
      .eq('id', employeeId)
      .single();
    if (!employee || employee.business_id !== businessId) throw new NotFoundError('Employee');

    // Obtener branch_ids del empleado (desde employee_branches existentes o desde la última invitación pendiente)
    const { data: employeeBranches } = await supabase
      .from('employee_branches')
      .select('branch_id')
      .eq('employee_id', employeeId)
      .eq('status', 'active');
    
    const branchIds = (employeeBranches || []).map((eb: any) => eb.branch_id);
    
    // Si no hay branches activas, intentar obtener desde la última invitación pendiente
    let invitationBranchIds = branchIds;
    if (branchIds.length === 0) {
      const { data: lastInvitation } = await supabase
        .from('employee_invitations')
        .select('branch_ids')
        .eq('employee_id', employeeId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (lastInvitation?.branch_ids) {
        invitationBranchIds = lastInvitation.branch_ids;
      }
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('employee_invitations')
      .insert({ 
        employee_id: employeeId, 
        token, 
        expires_at: expiresAt,
        branch_ids: invitationBranchIds // Guardar branch_ids como JSONB
      });

    const { data: branches } = await supabase
      .from('branches')
      .select('id, name')
      .in('id', invitationBranchIds.length > 0 ? invitationBranchIds : ['00000000-0000-0000-0000-000000000000']);

    const { data: business } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();

      const invitationUrl = `${process.env.FRONTEND_URL}/confirm/${businessId}/${token}/validate`;
      const messageText = `🎉 Hola ${employee.full_name}!

Has sido invitado a trabajar en:
🏢 *${business.name}*
📍 Sucursales: ${(branches || []).map((b: any) => b.name).filter(Boolean).join(', ')}

Este enlace expira en 24 horas.

_Powered by Timer_`;

      await fetch(`${process.env.BUILDERBOT_API_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.BUILDERBOT_API_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          number: employee.phone,
          message: messageText,
          buttonUrl: invitationUrl,
          buttonText: 'Unirme al Equipo',
        }),
      });

    return withCors(origin, Response.json({ ok: true }));
  } catch (error) {
    return handleApiError(error);
  }
}







