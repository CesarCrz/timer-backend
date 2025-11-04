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

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('employee_invitations')
      .insert({ employee_id: employeeId, token, expires_at: expiresAt });

    const { data: branches } = await supabase
      .from('employee_branches')
      .select('branch:branches(name)')
      .eq('employee_id', employeeId);

    const { data: business } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();

    await fetch(`${process.env.BUILDERBOT_API_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.BUILDERBOT_API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: employee.phone,
        message: `🎉 Hola ${employee.full_name}!

Has sido invitado a trabajar en:
🏢 *${business.name}*
📍 Sucursales: ${(branches || []).map((b: any) => b.branch?.name).filter(Boolean).join(', ')}

Para confirmar tu registro, haz clic aquí:
👉 ${process.env.FRONTEND_URL}/confirm/${businessId}/${token}/validate

Este enlace expira en 24 horas.

_Powered by Timer_`,
      }),
    });

    return withCors(origin, Response.json({ ok: true }));
  } catch (error) {
    return handleApiError(error);
  }
}







