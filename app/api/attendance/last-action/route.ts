import { handleApiError, UnauthorizedError } from '@/lib/utils/errors';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { withCors, preflight } from '@/lib/utils/cors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const authHeader = request.headers.get('authorization');
    if (!authHeader || authHeader !== `Bearer ${process.env.BUILDERBOT_API_SECRET}`) {
      throw new UnauthorizedError('Invalid API secret');
    }

    const url = new URL(request.url);
    const phone = url.searchParams.get('phone');
    if (!phone) {
      return withCors(origin, Response.json({ error: 'phone is required' }, { status: 400 }));
    }

    const supabase = createServiceRoleClient();
    const { data: employee } = await supabase
      .from('employees')
      .select('id')
      .eq('phone', phone)
      .eq('status', 'active')
      .maybeSingle();

    if (!employee) {
      return withCors(origin, Response.json({ has_active_checkin: false }));
    }

    const { data: activeRecord } = await supabase
      .from('attendance_records')
      .select('id, check_in_time, branch_id')
      .eq('employee_id', employee.id)
      .eq('status', 'active')
      .maybeSingle();

    return withCors(origin, Response.json({
      has_active_checkin: Boolean(activeRecord),
      active_record: activeRecord || null,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







