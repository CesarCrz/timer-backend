import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';
import { stripe } from '@/lib/stripe/client';
import { env } from '@/config/env';

const schema = z.object({
  return_url: z.string().url().optional(),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const body = await request.json().catch(() => ({}));
    const { return_url } = schema.parse(body);
    
    const supabase = createServiceRoleClient();

    // Obtener suscripción para obtener stripe_customer_id
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .maybeSingle();

    if (!subscription?.stripe_customer_id) {
      return withCors(origin, Response.json(
        { error: 'No active subscription found' },
        { status: 404 }
      ));
    }

    // Crear sesión del portal de Stripe
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: return_url || `${env.FRONTEND_URL}/dashboard/${user.id}/subscription`,
    });

    return withCors(origin, Response.json({ url: portalSession.url }));
  } catch (error) {
    return handleApiError(error);
  }
}

