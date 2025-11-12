import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';

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

    // Obtener información del business
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .single();

    if (businessError || !business) {
      return withCors(
        origin,
        Response.json({ error: 'Negocio no encontrado' }, { status: 404 })
      );
    }

    // Construir respuesta con información del owner desde el usuario actual
    // El getCurrentUser ya nos da la información del usuario autenticado
    const profileData = {
      ...business,
      owner: {
        email: user.email || '',
        user_metadata: user.user_metadata || {},
      },
    };

    return withCors(origin, Response.json(profileData));
  } catch (error) {
    return handleApiError(error);
  }
}

