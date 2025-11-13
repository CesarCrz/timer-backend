import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';
import { stripe } from '@/lib/stripe/client';
import { env } from '@/config/env';

const schema = z.object({
  tier_id: z.string().uuid(),
  billing_period: z.enum(['monthly', 'yearly']).default('monthly'),
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
    const body = await request.json();
    const { tier_id, billing_period } = schema.parse(body);
    
    const supabase = createServiceRoleClient();

    // Obtener tier para precio
    const { data: tier } = await supabase
      .from('subscription_tiers')
      .select('*')
      .eq('id', tier_id)
      .eq('is_active', true)
      .single();

    if (!tier) {
      return withCors(origin, Response.json(
        { error: 'Tier not found' },
        { status: 404 }
      ));
    }

    // Obtener o crear customer de Stripe
    let customerId: string;
    const { data: existingSubscription } = await supabase
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('business_id', businessId)
      .maybeSingle();

    if (existingSubscription?.stripe_customer_id) {
      customerId = existingSubscription.stripe_customer_id;
    } else {
      // Crear nuevo customer
      if (!user.email) {
        return withCors(origin, Response.json({ 
          error: 'El usuario no tiene un email configurado' 
        }, { status: 400 }));
      }
      
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          business_id: businessId,
          user_id: user.id,
        },
      });
      customerId = customer.id;
    }

    // Precio según período
    const price = billing_period === 'yearly' 
      ? tier.price_yearly_mxn 
      : tier.price_monthly_mxn;

    // Crear Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: {
              name: `Plan ${tier.name} - Timer`,
              description: `${tier.max_branches} sucursales, ${tier.max_employees} empleados`,
            },
            unit_amount: Math.round(price * 100), // Stripe usa centavos
            recurring: {
              interval: billing_period === 'yearly' ? 'year' : 'month',
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${env.FRONTEND_URL}/dashboard/${user.id}/subscription?success=true`,
      cancel_url: `${env.FRONTEND_URL}/dashboard/${user.id}/subscription?canceled=true`,
      metadata: {
        business_id: businessId,
        tier_id: tier_id,
        user_id: user.id,
      },
    });

    return withCors(origin, Response.json({ url: session.url }));
  } catch (error) {
    return handleApiError(error);
  }
}

