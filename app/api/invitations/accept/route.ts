import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { ValidationError, handleApiError } from '@/lib/utils/errors';
import { withCors, preflight } from '@/lib/utils/cors';

const acceptSchema = z.object({
  token: z.string().uuid(),
  terms_accepted: z.literal(true),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

// Función helper para limpiar el token
function cleanToken(token: string): string {
  // Decodificar la URL en caso de que Meta haya codificado {{1}} como %7B%7B1%7D%7D
  try {
    token = decodeURIComponent(token);
  } catch (e) {
    // Si falla la decodificación, usar el token original
  }
  
  // Si el token incluye {{1}} o %7B%7B1%7D%7D (Meta no reemplazó correctamente)
  // Extraer solo la parte del UUID que viene después
  if (token.includes('{{1}}') || token.includes('%7B%7B1%7D%7D')) {
    // Buscar el UUID directamente (formato: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    const uuidMatch = token.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch) {
      token = uuidMatch[1];
    } else {
      // Si no hay UUID, intentar extraer después de }} o %7D%7D
      const afterBraceMatch = token.match(/(?:\}\}|%7D%7D)(.+)$/);
      if (afterBraceMatch) {
        token = afterBraceMatch[1];
      }
    }
  }
  
  return token;
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const body = await request.json();
    
    // Procesar el token ANTES de validarlo con Zod
    const rawToken = body.token;
    if (!rawToken) throw new ValidationError('Token is required');
    
    const cleanedToken = cleanToken(rawToken);
    console.log(`🔍 [ACCEPT] Token recibido: ${rawToken}`);
    console.log(`🔍 [ACCEPT] Token procesado: ${cleanedToken}`);
    
    // Validar que el token limpiado sea un UUID válido
    const { token } = acceptSchema.parse({ token: cleanedToken, terms_accepted: body.terms_accepted });

    const supabase = createServiceRoleClient();
    const nowIso = new Date().toISOString();

    const { data: invitation } = await supabase
      .from('employee_invitations')
      .select('*')
      .eq('token', token)
      .single();

    if (!invitation) throw new ValidationError('Invalid token');
    if (invitation.status !== 'pending') throw new ValidationError('Token not pending');
    if (invitation.expires_at <= nowIso) throw new ValidationError('Token expired');

    const { data: employee } = await supabase
      .from('employees')
      .select('id')
      .eq('id', invitation.employee_id)
      .single();

    if (!employee) {
      throw new ValidationError('Employee not found');
    }

    // Obtener branch_ids y branch_hours de la invitación (guardados como JSONB)
    const branchIds = invitation.branch_ids || [];
    const branchHours = invitation.branch_hours || {};
    
    // Crear las relaciones employee_branches solo cuando acepta la invitación
    if (branchIds.length > 0) {
      const rows = branchIds.map((bid: string) => {
        const hours = branchHours[bid] || {};
        const row: any = { 
          employee_id: employee.id, 
          branch_id: bid, 
          status: 'active' 
        };
        
        // Aplicar horarios específicos si están presentes
        if (hours.start && hours.end) {
          row.employees_hours_start = hours.start;
          row.employees_hours_end = hours.end;
          row.tolerance_minutes = hours.tolerance || 0;
        }
        
        return row;
      });
      
      const { error: branchError } = await supabase
        .from('employee_branches')
        .insert(rows);
      
      if (branchError) {
        console.error('Error inserting employee_branches:', branchError);
        throw new Error(branchError.message || 'Error al asignar sucursales');
      }
    }

    await supabase
      .from('employees')
      .update({ status: 'active', terms_accepted_at: nowIso })
      .eq('id', employee.id);

    await supabase
      .from('employee_invitations')
      .update({ status: 'accepted' })
      .eq('id', invitation.id);

    return withCors(origin, Response.json({ message: 'Invitation accepted successfully', employee_id: employee.id }));
  } catch (error) {
    return handleApiError(error);
  }
}







