import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, PlanLimitError } from '@/lib/utils/errors';
import { validatePlanLimits } from '@/lib/utils/validation';

const branchSchema = z.object({
  name: z.string().min(3).max(50),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().optional(),
  tolerance_radius_meters: z.number().min(10).max(200).default(100),
  timezone: z.string().default('America/Mexico_City'),
  business_hours_start: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).default('08:00:00'),
  business_hours_end: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).default('23:00:00'),
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
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || undefined;

    const supabase = createServiceRoleClient();
    let query = supabase
      .from('branches')
      .select('*', { count: 'exact' })
      .eq('business_id', businessId);
    if (status) query = query.eq('status', status);
    const { data: branches, count } = await query;
    return withCors(origin, Response.json({ branches: branches || [], total: count || 0 }));
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
    const payload = branchSchema.parse(body);

    const supabase = createServiceRoleClient();
    const limits = await validatePlanLimits(supabase, businessId, 'branches');
    if (!limits.allowed) throw new PlanLimitError('branches', limits.current, limits.max);

    const { data: inserted } = await supabase
      .from('branches')
      .insert({ ...payload, business_id: businessId, status: 'active' })
      .select()
      .single();

    return withCors(origin, Response.json(inserted));
  } catch (error) {
    return handleApiError(error);
  }
}







