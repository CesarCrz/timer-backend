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
    let body: any;
    
    try {
      body = await request.json();
    } catch (error) {
      console.error('❌ [ACCEPT] Error parsing request body:', error);
      throw new ValidationError('Invalid request body');
    }
    
    // Procesar el token ANTES de validarlo con Zod
    const rawToken = body?.token;
    if (!rawToken || typeof rawToken !== 'string') {
      throw new ValidationError('Token is required');
    }
    
    const cleanedToken = cleanToken(rawToken);
    console.log(`🔍 [ACCEPT] Token recibido: ${rawToken}`);
    console.log(`🔍 [ACCEPT] Token procesado: ${cleanedToken}`);
    
    // Validar que el token limpiado sea un UUID válido y terms_accepted sea true
    if (body.terms_accepted !== true) {
      throw new ValidationError('Terms must be accepted');
    }
    
    let token: string;
    try {
      const parsed = acceptSchema.parse({ token: cleanedToken, terms_accepted: body.terms_accepted });
      token = parsed.token;
    } catch (zodError: any) {
      console.error('❌ [ACCEPT] Zod validation error:', zodError);
      throw new ValidationError(zodError.errors?.[0]?.message || 'Invalid token format');
    }

    const supabase = createServiceRoleClient();
    const nowIso = new Date().toISOString();

    const { data: invitation, error: invitationError } = await supabase
      .from('employee_invitations')
      .select('*')
      .eq('token', token)
      .single();

    if (invitationError || !invitation) {
      console.error('❌ [ACCEPT] Invitation not found:', invitationError);
      throw new ValidationError('Invalid token');
    }
    
    if (invitation.status !== 'pending') {
      console.warn(`⚠️ [ACCEPT] Token status is not pending: ${invitation.status}`);
      throw new ValidationError('Token not pending');
    }
    
    if (invitation.expires_at <= nowIso) {
      console.warn(`⚠️ [ACCEPT] Token expired: ${invitation.expires_at} <= ${nowIso}`);
      throw new ValidationError('Token expired');
    }

    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('id')
      .eq('id', invitation.employee_id)
      .single();

    if (employeeError || !employee) {
      console.error('❌ [ACCEPT] Employee not found:', employeeError);
      throw new ValidationError('Employee not found');
    }

    // Obtener branch_ids y branch_hours de la invitación (guardados como JSONB)
    // Validar y normalizar los tipos para evitar errores de TypeScript
    let branchIds: string[] = [];
    if (invitation.branch_ids) {
      if (Array.isArray(invitation.branch_ids)) {
        branchIds = invitation.branch_ids.filter((id: any) => typeof id === 'string' && id.length > 0);
      } else if (typeof invitation.branch_ids === 'string') {
        // Si es un string, intentar parsearlo como JSON
        try {
          const parsed = JSON.parse(invitation.branch_ids);
          if (Array.isArray(parsed)) {
            branchIds = parsed.filter((id: any) => typeof id === 'string' && id.length > 0);
          }
        } catch (e) {
          console.warn('Error parsing branch_ids as JSON:', e);
        }
      }
    }
    
    let branchHours: Record<string, { start?: string; end?: string; tolerance?: number }> = {};
    if (invitation.branch_hours) {
      if (typeof invitation.branch_hours === 'object' && invitation.branch_hours !== null) {
        branchHours = invitation.branch_hours as Record<string, { start?: string; end?: string; tolerance?: number }>;
      } else if (typeof invitation.branch_hours === 'string') {
        try {
          branchHours = JSON.parse(invitation.branch_hours);
        } catch (e) {
          console.warn('Error parsing branch_hours as JSON:', e);
        }
      }
    }
    
    // Crear las relaciones employee_branches solo cuando acepta la invitación
    if (branchIds.length > 0) {
      // Verificar si ya existen relaciones employee_branches para este empleado
      const { data: existingBranches, error: checkError } = await supabase
        .from('employee_branches')
        .select('branch_id')
        .eq('employee_id', employee.id);
      
      if (checkError) {
        console.warn('⚠️ [ACCEPT] Error al verificar branches existentes (continuando):', checkError);
      }
      
      const existingBranchIds = new Set((existingBranches || []).map((eb: any) => eb.branch_id));
      
      // Filtrar solo las branches que no existen ya
      const newBranchIds = branchIds.filter((bid: string) => !existingBranchIds.has(bid));
      
      if (newBranchIds.length > 0) {
        const rows = newBranchIds.map((bid: string) => {
          const hours = branchHours[bid] || {};
          const row: { 
            employee_id: string; 
            branch_id: string; 
            status: string;
            employees_hours_start?: string;
            employees_hours_end?: string;
            tolerance_minutes?: number;
          } = { 
            employee_id: employee.id, 
            branch_id: bid, 
            status: 'active' 
          };
          
          // Aplicar horarios específicos si están presentes
          if (hours && typeof hours === 'object' && hours.start && hours.end) {
            row.employees_hours_start = String(hours.start);
            row.employees_hours_end = String(hours.end);
            row.tolerance_minutes = typeof hours.tolerance === 'number' ? hours.tolerance : 0;
          }
          
          return row;
        });
        
        const { error: branchError } = await supabase
          .from('employee_branches')
          .insert(rows);
        
        if (branchError) {
          console.error('❌ [ACCEPT] Error inserting employee_branches:', branchError);
          // Si el error es por duplicado (código 23505), no es crítico
          if (branchError.code === '23505') {
            console.warn('⚠️ [ACCEPT] Duplicate key error (algunas branches ya existían, continuando)');
          } else {
            throw new ValidationError(branchError.message || 'Error al asignar sucursales', { 
              code: 'BRANCH_ASSIGNMENT_ERROR',
              details: branchError 
            });
          }
        } else {
          console.log(`✅ [ACCEPT] ${rows.length} relación(es) employee_branches creada(s)`);
        }
      } else {
        console.log('ℹ️ [ACCEPT] Todas las branches ya están asignadas al empleado');
      }
      
      // Actualizar horarios específicos para branches existentes si se proporcionaron
      for (const bid of branchIds) {
        const hours = branchHours[bid];
        if (hours && typeof hours === 'object' && hours.start && hours.end && existingBranchIds.has(bid)) {
          const updateData: any = {
            employees_hours_start: String(hours.start),
            employees_hours_end: String(hours.end),
            tolerance_minutes: typeof hours.tolerance === 'number' ? hours.tolerance : 0,
          };
          
          const { error: updateError } = await supabase
            .from('employee_branches')
            .update(updateData)
            .eq('employee_id', employee.id)
            .eq('branch_id', bid);
          
          if (updateError) {
            console.warn(`⚠️ [ACCEPT] Error al actualizar horarios para branch ${bid}:`, updateError);
          }
        }
      }
    }

    // Actualizar estado del empleado
    const { error: updateEmployeeError } = await supabase
      .from('employees')
      .update({ status: 'active', terms_accepted_at: nowIso })
      .eq('id', employee.id);

    if (updateEmployeeError) {
      console.error('❌ [ACCEPT] Error updating employee:', updateEmployeeError);
      throw new ValidationError('Error al actualizar empleado', { 
        code: 'EMPLOYEE_UPDATE_ERROR',
        details: updateEmployeeError 
      });
    }

    // Actualizar estado de la invitación
    const { error: updateInvitationError } = await supabase
      .from('employee_invitations')
      .update({ status: 'accepted' })
      .eq('id', invitation.id);

    if (updateInvitationError) {
      console.error('❌ [ACCEPT] Error updating invitation:', updateInvitationError);
      // No lanzar error aquí porque el empleado ya fue actualizado
      console.warn('⚠️ [ACCEPT] Employee updated but invitation status update failed');
    }

    console.log(`✅ [ACCEPT] Invitation accepted successfully for employee ${employee.id}`);
    return withCors(origin, Response.json({ 
      message: 'Invitation accepted successfully', 
      employee_id: employee.id 
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







