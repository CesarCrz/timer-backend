import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';

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

    // Obtener suscripción activa con tier
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('*, tier:subscription_tiers(*)')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .maybeSingle();

    // Si no hay suscripción, retornar estructura vacía
    if (!subscription || !subscription.tier) {
      return withCors(origin, Response.json({
        current_tier: null,
        current_usage: {
          branches: 0,
          employees: 0,
        },
        stripe_subscription: null,
      }));
    }

    // Contar uso actual
    const { count: branchesCount } = await supabase
      .from('branches')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    const { count: employeesCount } = await supabase
      .from('employees')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    return withCors(origin, Response.json({
      current_tier: {
        id: subscription.tier.id,
        name: subscription.tier.name,
        price_monthly: subscription.tier.price_monthly_mxn,
        price_yearly: subscription.tier.price_yearly_mxn,
        max_branches: subscription.tier.max_branches,
        max_employees: subscription.tier.max_employees,
      },
      current_usage: {
        branches: branchesCount || 0,
        employees: employeesCount || 0,
      },
      stripe_subscription: {
        status: subscription.status,
        current_period_end: subscription.current_period_end,
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

