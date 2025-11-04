import { createServiceRoleClient } from '@/lib/utils/auth';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const supabase = createServiceRoleClient();

    const { data: tiers } = await supabase
      .from('subscription_tiers')
      .select('id, name, price_monthly_mxn, price_yearly_mxn, max_branches, max_employees, features, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    return withCors(origin, Response.json({ tiers: tiers || [] }));
  } catch (error) {
    return handleApiError(error);
  }
}







