import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, PlanLimitError } from '@/lib/utils/errors';
import { validatePlanLimits } from '@/lib/utils/validation';

const employeeSchema = z.object({
  full_name: z.string().min(3).max(100),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  hourly_rate: z.number().positive().max(10000),
  branch_ids: z.array(z.string().uuid()).min(1),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const supabase = createServiceRoleClient();
    const { data: employees } = await supabase
      .from('employees')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });
    return withCors(origin, Response.json({ employees: employees || [] }));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const body = await request.json();
    const payload = employeeSchema.parse(body);

    const supabase = createServiceRoleClient();
    const limits = await validatePlanLimits(supabase, businessId, 'employees');
    if (!limits.allowed) throw new PlanLimitError('employees', limits.current, limits.max);

    const { data: employee } = await supabase
      .from('employees')
      .insert({
        business_id: businessId,
        full_name: payload.full_name,
        phone: payload.phone,
        hourly_rate: payload.hourly_rate,
        status: 'pending',
      })
      .select()
      .single();

    if (payload.branch_ids?.length) {
      const rows = payload.branch_ids.map((bid) => ({ employee_id: employee.id, branch_id: bid, status: 'active' }));
      await supabase.from('employee_branches').insert(rows);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('employee_invitations').insert({ employee_id: employee.id, token, expires_at: expiresAt });

    // Send WhatsApp via BuilderBot
    try {
      const { data: business } = await supabase
        .from('businesses')
        .select('name')
        .eq('id', businessId)
        .single();
      const { data: branches } = await supabase
        .from('branches')
        .select('name')
        .in('id', payload.branch_ids);

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
📍 Sucursales: ${(branches || []).map((b: any) => b.name).join(', ')}

Para confirmar tu registro, haz clic aquí:
👉 ${process.env.FRONTEND_URL}/confirm/${businessId}/${token}/validate

Este enlace expira en 24 horas.

_Powered by Timer_`,
        }),
      });
    } catch (e) {
      console.error('Failed to send WhatsApp invitation:', e);
    }

    return withCors(origin, Response.json({
      ...employee,
      branches: payload.branch_ids || [],
      invitation_sent: true,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







