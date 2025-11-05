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

    // Obtener suscripción activa
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('*, tier:subscription_tiers(*)')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .maybeSingle();

    // Si no hay suscripción, retornar datos por defecto
    if (!subscription) {
      return withCors(origin, Response.json({
        has_subscription: false,
        plan_name: null,
        max_branches: 0,
        max_employees: 0,
        current_branches: 0,
        current_employees: 0,
      }));
    }

    // Obtener tier con límites
    const tier = subscription.tier;
    if (!tier) {
      return withCors(origin, Response.json({
        has_subscription: false,
        plan_name: null,
        max_branches: 0,
        max_employees: 0,
        current_branches: 0,
        current_employees: 0,
      }));
    }

    // Contar sucursales y empleados actuales
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
      has_subscription: true,
      plan_name: tier.name,
      max_branches: tier.max_branches,
      max_employees: tier.max_employees,
      current_branches: branchesCount || 0,
      current_employees: employeesCount || 0,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

