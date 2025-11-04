import { z } from 'zod';

export const phoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'Invalid phone format. Use E.164, e.g., +14155552671');

export const emailSchema = z.string().email('Invalid email').toLowerCase();

export const uuidSchema = z.string().uuid('Invalid UUID');

export const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}$/u, 'Invalid time format (HH:MM:SS)');

export const dateRangeSchema = z
  .object({
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine(data => new Date(data.start_date) <= new Date(data.end_date), {
    message: 'start_date must be <= end_date',
  });

export async function validatePlanLimits(
  supabase: any,
  businessId: string,
  resource: 'branches' | 'employees'
): Promise<{ allowed: boolean; current: number; max: number }> {
  const { data: subscription } = await supabase
    .from('user_subscriptions')
    .select('tier_id')
    .eq('business_id', businessId)
    .eq('status', 'active')
    .single();

  if (!subscription) {
    throw new Error('No active subscription found');
  }

  const { data: tier } = await supabase
    .from('subscription_tiers')
    .select(resource === 'branches' ? 'max_branches' : 'max_employees')
    .eq('id', subscription.tier_id)
    .single();

  const maxAllowed = resource === 'branches' ? tier.max_branches : tier.max_employees;

  const table = resource === 'branches' ? 'branches' : 'employees';
  const { count } = await supabase
    .from(table)
    .select('id', { count: 'exact' })
    .eq('business_id', businessId)
    .eq('status', 'active');

  return { allowed: count < maxAllowed, current: count, max: maxAllowed };
}







