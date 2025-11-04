import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';

const schema = z.object({ new_plan: z.string() });

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const body = await request.json();
    const { new_plan } = schema.parse(body);

    const supabase = createServiceRoleClient();
    const planNameMap: Record<string, string> = {
      basic: 'Básico',
      professional: 'Profesional',
      enterprise: 'Empresarial',
    };

    const desiredName = planNameMap[new_plan] || new_plan;
    const { data: tier } = await supabase
      .from('subscription_tiers')
      .select('id')
      .eq('name', desiredName)
      .single();

    if (!tier) {
      return withCors(origin, Response.json({ error: 'Tier not found' }, { status: 400 }));
    }

    // Update local subscription tier reference (actual billing handled by Stripe Checkout outside scope)
    await supabase
      .from('user_subscriptions')
      .update({ tier_id: tier.id })
      .eq('business_id', businessId);

    return withCors(origin, Response.json({ changed: true }));
  } catch (error) {
    return handleApiError(error);
  }
}



