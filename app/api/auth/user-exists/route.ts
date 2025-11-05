import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';

const schema = z.object({
  email: z.string().email(),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const body = await request.json();
    const { email } = schema.parse(body);

    const supabase = createServiceRoleClient();

    // Buscar en businesses por email
    const { data, error } = await supabase
      .from('businesses')
      .select('id, email')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    
    // Si el error es PGRST116 (no encontrado), retornar exists: false
    if (error) {
      // PGRST116 = "The result contains 0 rows"
      if (error.code === 'PGRST116') {
        return withCors(origin, Response.json({ exists: false }));
      }
      return handleApiError(error);
    }

    return withCors(origin, Response.json({ exists: !!data }));
  } catch (error) {
    return handleApiError(error);
  }
}


