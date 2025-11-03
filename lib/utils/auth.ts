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
  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('owner_id', userId)
    .single();
  if (!business) {
    throw new Error('Business not found for user');
  }
  return business.id as string;
}


