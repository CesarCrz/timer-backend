import { NextRequest } from 'next/server';
import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { sendEmail } from '@/lib/emails/client';
import { renderTemplate } from '@/lib/emails/templates';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature')!;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  let event: any;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err: any) {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
        
        // Obtener información del tier y business
        const { data: tier } = await supabase
          .from('subscription_tiers')
          .select('*')
          .eq('id', session.metadata?.tier_id)
          .single();
        
        const { data: business } = await supabase
          .from('businesses')
          .select('id, owner_id')
          .eq('id', session.metadata?.business_id)
          .single();
        
        // Verificar si ya existe suscripción para este negocio
        const { data: existing } = await supabase
          .from('user_subscriptions')
          .select('id')
          .eq('business_id', session.metadata?.business_id)
          .maybeSingle();

        if (existing) {
          // Actualizar suscripción existente (upgrade/downgrade)
          await supabase
            .from('user_subscriptions')
            .update({
              tier_id: session.metadata?.tier_id,
              stripe_subscription_id: subscription.id,
              stripe_customer_id: subscription.customer as string,
              status: 'active',
              current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
              current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
              cancel_at_period_end: false,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
        } else {
          // Crear nueva suscripción
          await supabase.from('user_subscriptions').insert({
            business_id: session.metadata?.business_id,
            tier_id: session.metadata?.tier_id,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            status: 'active',
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          });
        }
        
        // Obtener el email del owner usando auth.admin
        let ownerEmail: string | null = null;
        if (business?.owner_id) {
          try {
            const { data: userData, error: userError } = await supabase.auth.admin.getUserById(business.owner_id);
            if (!userError && userData?.user?.email) {
              ownerEmail = userData.user.email;
            }
          } catch (error) {
            console.error('Error obteniendo email del owner:', error);
          }
        }
        
        // Enviar correo de confirmación
        if (business && tier && ownerEmail) {
          try {
            const renewalDate = dayjs(subscription.current_period_end * 1000).format('DD/MM/YYYY');
            const nextBillingDate = dayjs(subscription.current_period_end * 1000).format('DD/MM/YYYY');
            const features = tier.features && Array.isArray(tier.features) ? tier.features : [];
            
            const { subject, html } = renderTemplate('subscription-confirmed', {
              planName: tier.name,
              priceMxn: parseFloat(tier.price_monthly_mxn).toFixed(2),
              renewalDate,
              maxEmployees: tier.max_employees,
              maxBranches: tier.max_branches,
              features,
              nextBillingDate,
              dashboardUrl: `${process.env.FRONTEND_URL || 'https://timer.app'}/dashboard`,
              settingsUrl: `${process.env.FRONTEND_URL || 'https://timer.app'}/subscription`,
            });
            
            await sendEmail({
              to: ownerEmail,
              subject,
              html,
            });
          } catch (emailError: any) {
            console.error('Error enviando correo de suscripción confirmada:', emailError);
            // No fallar el webhook si falla el correo
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        await supabase
          .from('user_subscriptions')
          .update({
            status: subscription.status,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: subscription.cancel_at_period_end,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_subscription_id', subscription.id);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await supabase
          .from('user_subscriptions')
          .update({ status: 'canceled' })
          .eq('stripe_subscription_id', subscription.id);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await supabase
          .from('user_subscriptions')
          .update({ status: 'past_due' })
          .eq('stripe_subscription_id', invoice.subscription as string);
        break;
      }
      default:
        break;
    }
    return Response.json({ received: true });
  } catch (error: any) {
    return Response.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}







