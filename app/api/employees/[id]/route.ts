import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';

const updateSchema = z.object({
  full_name: z.string().min(3).max(100).optional(),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
  hourly_rate: z.number().min(1).max(10000).optional(), // Changed from positive() to min(1)
  status: z.enum(['pending', 'active', 'inactive']).optional(),
  branch_ids: z.array(z.string().uuid()).optional(), // Permite array vacío para desactivar de todas las sucursales
  // Premium features: horarios por sucursal
  branch_hours: z.record(
    z.string().uuid(),
    z.object({
      start: z.preprocess(
        (val) => {
          if (val === undefined || val === null) return undefined;
          if (typeof val !== 'string') return undefined;
          const trimmed = val.trim();
          if (trimmed === '') return undefined;
          // Normalizar HH:MM:SS a HH:MM
          if (trimmed.includes(':') && trimmed.split(':').length === 3) {
            return trimmed.substring(0, 5); // Toma solo HH:MM
          }
          return trimmed;
        },
        z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/).optional()
      ),
      end: z.preprocess(
        (val) => {
          if (val === undefined || val === null) return undefined;
          if (typeof val !== 'string') return undefined;
          const trimmed = val.trim();
          if (trimmed === '') return undefined;
          // Normalizar HH:MM:SS a HH:MM
          if (trimmed.includes(':') && trimmed.split(':').length === 3) {
            return trimmed.substring(0, 5); // Toma solo HH:MM
          }
          return trimmed;
        },
        z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/).optional()
      ),
      tolerance: z.number().min(0).max(59).optional(),
    })
  ).optional(),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const employeeId = id;
    const body = await request.json();
    
    // Debug: Log para ver qué está llegando
    if (body.branch_hours) {
      console.log('🔍 [DEBUG] branch_hours recibido:', JSON.stringify(body.branch_hours, null, 2));
    }
    
    const updates = updateSchema.parse(body);

    const supabase = createServiceRoleClient();
    const { data: existing } = await supabase
      .from('employees')
      .select('id, business_id')
      .eq('id', employeeId)
      .single();
    if (!existing || existing.business_id !== businessId) throw new NotFoundError('Employee');

    // Check if user has premium subscription (not basic)
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('tier:subscription_tiers(name)')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .single();

    // Type guard para tier
    const tier = subscription?.tier && !Array.isArray(subscription.tier) 
      ? subscription.tier as { name: string }
      : null;
    const tierName = tier?.name || null;
    const isPremium = tierName !== null && tierName !== 'Básico';

    // Validate premium features: branch_hours
    if (!isPremium && updates.branch_hours && Object.keys(updates.branch_hours).length > 0) {
      return withCors(origin, Response.json(
        {
          error: 'Premium feature required',
          code: 'PREMIUM_REQUIRED',
          message: 'Los horarios específicos por sucursal están disponibles solo para planes Premium. Actualiza tu plan para utilizar esta característica.',
        },
        { status: 403 }
      ));
    }

    // Validate branch_hours if provided
    if (isPremium && updates.branch_hours) {
      for (const [branchId, hours] of Object.entries(updates.branch_hours)) {
        const h = hours as { start?: string; end?: string; tolerance?: number };
        
        // Normalizar strings vacíos a undefined
        const start = h.start?.trim() || undefined;
        const end = h.end?.trim() || undefined;
        
        // Si se proporciona start o end, ambos deben estar presentes y no vacíos
        if ((start && !end) || (!start && end)) {
          return withCors(origin, Response.json(
            {
              error: 'Validation error',
              code: 'VALIDATION_ERROR',
              message: `Para la sucursal ${branchId}, si especificas un horario, debes proporcionar tanto la hora de inicio como la de fin.`,
            },
            { status: 400 }
          ));
        }
        
        // Si ambos están presentes, validar formato y que start < end
        if (start && end) {
          // Validar formato HH:MM
          const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
          if (!timeRegex.test(start) || !timeRegex.test(end)) {
            return withCors(origin, Response.json(
              {
                error: 'Validation error',
                code: 'VALIDATION_ERROR',
                message: `Para la sucursal ${branchId}, los horarios deben estar en formato HH:MM (ej: 09:00).`,
              },
              { status: 400 }
            ));
          }
          
          const [startHour, startMin] = start.split(':').map(Number);
          const [endHour, endMin] = end.split(':').map(Number);
          const startMinutes = startHour * 60 + startMin;
          const endMinutes = endHour * 60 + endMin;

          if (startMinutes >= endMinutes) {
            return withCors(origin, Response.json(
              {
                error: 'Validation error',
                code: 'VALIDATION_ERROR',
                message: `Para la sucursal ${branchId}, la hora de inicio debe ser menor que la hora de fin.`,
              },
              { status: 400 }
            ));
          }
        }
      }
    }

    const { branch_ids, branch_hours, ...empUpdates } = updates;
    
    // Prepare employee updates (sin horarios, esos van a employee_branches)
    const employeeData: any = { ...empUpdates };
    const { data: updated, error: updateError } = await supabase
      .from('employees')
      .update(employeeData)
      .eq('id', employeeId)
      .select()
      .single();

    if (updateError || !updated) {
      throw new NotFoundError('Employee');
    }

    if (branch_ids !== undefined) {
      // Obtener todas las relaciones actuales del empleado
      const { data: currentBranches } = await supabase
        .from('employee_branches')
        .select('branch_id, status')
        .eq('employee_id', employeeId);

      const currentBranchIds = currentBranches?.map(eb => eb.branch_id) || [];
      const newBranchIds = branch_ids || [];

      // Sucursales a ELIMINAR (estaban en la lista pero ya no están)
      // IMPORTANTE: Eliminar completamente, no solo desactivar
      const branchesToRemove = currentBranchIds.filter(bid => !newBranchIds.includes(bid));
      if (branchesToRemove.length > 0) {
        await supabase
          .from('employee_branches')
          .delete()
          .eq('employee_id', employeeId)
          .in('branch_id', branchesToRemove);
      }

      // Sucursales a agregar (están en la nueva lista pero no en la actual)
      const branchesToAdd = newBranchIds.filter(bid => !currentBranchIds.includes(bid));
      if (branchesToAdd.length > 0) {
        // Insertar nuevas relaciones (siempre como 'active')
        const rowsToInsert = branchesToAdd.map((bid) => {
          const row: any = { 
            employee_id: employeeId, 
            branch_id: bid, 
            status: 'active' 
          };
          
          // Aplicar horarios si están presentes en branch_hours
          if (branch_hours && branch_hours[bid]) {
            const hours = branch_hours[bid];
            // Normalizar strings vacíos
            const start = hours.start?.trim() || undefined;
            const end = hours.end?.trim() || undefined;
            if (start && end) {
              row.employees_hours_start = start;
              row.employees_hours_end = end;
              row.tolerance_minutes = hours.tolerance || 0;
            }
          }
          
          return row;
        });
        
        await supabase
          .from('employee_branches')
          .insert(rowsToInsert);
      }
      
      // Actualizar horarios de sucursales existentes si branch_hours está presente
      if (branch_hours) {
        for (const [branchId, hours] of Object.entries(branch_hours)) {
          // Solo actualizar si la sucursal está en la lista actual
          if (newBranchIds.includes(branchId)) {
            const updateData: any = {};
            
            // Normalizar strings vacíos
            const start = hours.start?.trim() || undefined;
            const end = hours.end?.trim() || undefined;
            
            if (start && end) {
              updateData.employees_hours_start = start;
              updateData.employees_hours_end = end;
              updateData.tolerance_minutes = hours.tolerance || 0;
            } else {
              // Si se envía vacío, eliminar horarios específicos (usar horario de sucursal)
              updateData.employees_hours_start = null;
              updateData.employees_hours_end = null;
              updateData.tolerance_minutes = null;
            }
            
            await supabase
              .from('employee_branches')
              .update(updateData)
              .eq('employee_id', employeeId)
              .eq('branch_id', branchId);
          }
        }
      }
    }

    return withCors(origin, Response.json(updated));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/employees/[id]
 * Elimina permanentemente un empleado (hard delete)
 * ⚠️ Esta acción es irreversible y eliminará todos los registros relacionados
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const employeeId = id;

    const supabase = createServiceRoleClient();
    const { data: existing } = await supabase
      .from('employees')
      .select('id, business_id')
      .eq('id', employeeId)
      .single();
    
    if (!existing || existing.business_id !== businessId) {
      throw new NotFoundError('Employee');
    }

    // Eliminar permanentemente el empleado
    // Las relaciones employee_branches se eliminarán automáticamente por CASCADE
    // Los registros de asistencia (attendance_records) también se eliminarán por CASCADE
    // Las invitaciones (employee_invitations) también se eliminarán por CASCADE
    await supabase
      .from('employees')
      .delete()
      .eq('id', employeeId);
    
    return withCors(origin, Response.json({ 
      message: 'Employee deleted permanently', 
      id: employeeId 
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







