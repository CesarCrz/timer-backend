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
    const now = new Date().toISOString();
    
    // Obtener información del usuario para owner_name
    // Usar el admin API de Supabase para obtener datos del usuario
    let ownerName: string | null = null;
    try {
      // El Service Role Client tiene acceso al admin API
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
      
      if (!userError && userData?.user) {
        ownerName = userData.user.user_metadata?.full_name 
          || userData.user.email 
          || null;
      }
    } catch (err) {
      // Si falla obtener el nombre, continuar sin él (el trigger lo intentará)
      // No es crítico, el business se creará de todas formas
      console.warn('Could not fetch user data for owner_name, trigger will handle it:', err);
    }
    
    // Preparar datos de inserción
    const insertData: any = {
      owner_id: userId,
      name: 'Mi Negocio',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      terms_accepted_at: now,
      privacy_accepted_at: now,
    };
    
    // Solo agregar owner_name si lo obtuvimos exitosamente
    // Si es null, el trigger lo intentará establecer
    if (ownerName) {
      insertData.owner_name = ownerName;
    }
    
    const { data: newBusiness, error: insertError } = await supabase
      .from('businesses')
      .insert(insertData)
      .select('id')
      .single();
    
    if (insertError) {
      console.error('Error creating business:', insertError);
      throw new Error(`Failed to create business for user: ${insertError.message}`);
    }
    
    if (!newBusiness) {
      throw new Error('Failed to create business for user: No data returned');
    }
    business = newBusiness;
  }
  
  return business.id as string;
}







