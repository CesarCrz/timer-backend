import { createServerClient } from '@supabase/ssr';

export function createServiceRoleClient() {
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        get() {
          return undefined;
        },
      },
    }
  );
}

export async function getCurrentUser(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.replace('Bearer ', '');

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get() {
          return undefined;
        },
      },
    }
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    throw new Error('Unauthorized');
  }
  return user;
}

export async function getUserBusinessId(userId: string) {
  const supabase = createServiceRoleClient();
  let { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('owner_id', userId)
    .maybeSingle();
  
  // Si no existe, crear uno por defecto
  if (!business) {
    const { data: newBusiness } = await supabase
      .from('businesses')
      .insert({
        owner_id: userId,
        name: 'Mi Negocio',
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      })
      .select('id')
      .single();
    
    if (!newBusiness) {
      throw new Error('Failed to create business for user');
    }
    business = newBusiness;
  }
  
  return business.id as string;
}







