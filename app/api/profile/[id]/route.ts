import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';

const updateSchema = z.object({
  name: z.string().min(1, 'El nombre del negocio es requerido').max(255, 'El nombre es demasiado largo'),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const body = await request.json();
    const payload = updateSchema.parse(body);
    const supabase = createServiceRoleClient();

    // Verificar que el business pertenece al usuario
    const businessId = await getUserBusinessId(user.id);
    if (params.id !== businessId) {
      return withCors(
        origin,
        Response.json({ error: 'No tienes permiso para actualizar este negocio' }, { status: 403 })
      );
    }

    // Validar que no exista otro negocio con el mismo nombre (case-insensitive)
    const { data: existingBusiness } = await supabase
      .from('businesses')
      .select('id, name')
      .ilike('name', payload.name.trim())
      .neq('id', businessId)
      .maybeSingle();

    if (existingBusiness) {
      return withCors(
        origin,
        Response.json(
          { error: 'Ya existe un negocio con ese nombre. Por favor, elige otro nombre.' },
          { status: 400 }
        )
      );
    }

    // Actualizar solo el nombre
    const { data: updated, error } = await supabase
      .from('businesses')
      .update({
        name: payload.name.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', businessId)
      .select()
      .single();

    if (error) throw error;

    return withCors(origin, Response.json(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

