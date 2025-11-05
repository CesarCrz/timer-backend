import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';

const businessSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  timezone: z.string().optional().default('America/Mexico_City'),
  currency: z.string().optional().default('MXN'),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

// GET: Obtener o crear business del usuario actual
export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const supabase = createServiceRoleClient();

    // Buscar business existente
    let { data: business } = await supabase
      .from('businesses')
      .select('*')
      .eq('owner_id', user.id)
      .maybeSingle();

    // Si no existe, crear uno con el nombre del metadata o email
    if (!business) {
      const businessName = user.user_metadata?.company || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Mi Negocio';
      const { data: newBusiness } = await supabase
        .from('businesses')
        .insert({
          owner_id: user.id,
          name: businessName,
          email: user.email?.toLowerCase() || null,
          timezone: user.user_metadata?.timezone || 'America/Mexico_City',
          currency: 'MXN',
        })
        .select()
        .single();

      business = newBusiness;
    }

    return withCors(origin, Response.json(business));
  } catch (error) {
    return handleApiError(error);
  }
}

// POST: Crear o actualizar business
export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const body = await request.json();
    const payload = businessSchema.parse(body);
    const supabase = createServiceRoleClient();

    // Verificar si ya existe
    const { data: existing } = await supabase
      .from('businesses')
      .select('id')
      .eq('owner_id', user.id)
      .maybeSingle();

    if (existing) {
      // Actualizar business existente
      const updateData: any = {
        name: payload.name,
        timezone: payload.timezone,
        currency: payload.currency,
        updated_at: new Date().toISOString(),
      };
      
      // Actualizar email solo si se proporciona
      if (payload.email) {
        updateData.email = payload.email.toLowerCase();
      } else if (user.email) {
        // Si no se proporciona pero el usuario tiene email, actualizarlo
        updateData.email = user.email.toLowerCase();
      }
      
      const { data: updated } = await supabase
        .from('businesses')
        .update(updateData)
        .eq('id', existing.id)
        .select()
        .single();

      return withCors(origin, Response.json(updated));
    }

    // Crear nuevo business
    const { data: newBusiness } = await supabase
      .from('businesses')
      .insert({
        owner_id: user.id,
        name: payload.name,
        email: payload.email?.toLowerCase() || user.email?.toLowerCase() || null,
        timezone: payload.timezone,
        currency: payload.currency,
      })
      .select()
      .single();

    return withCors(origin, Response.json(newBusiness));
  } catch (error) {
    return handleApiError(error);
  }
}




