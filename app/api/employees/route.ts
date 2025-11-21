import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, PlanLimitError } from '@/lib/utils/errors';
import { validatePlanLimits } from '@/lib/utils/validation';
import { assignSystemNumberToEmployee, getSystemNumberCredentials } from '@/lib/utils/system-numbers';

const employeeSchema = z.object({
  full_name: z.string().min(3).max(100),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  hourly_rate: z.number().min(1).max(10000), // Changed from positive() to min(1)
  branch_ids: z.array(z.string().uuid()).min(1),
  // Premium features: horarios por sucursal
  // branch_hours: { [branchId]: { start: string, end: string, tolerance: number } }
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

export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const supabase = createServiceRoleClient();
    
    // Obtener query parameter para filtro
    const url = new URL(request.url);
    const filter = url.searchParams.get('filter');
    
    // Si el filtro es "working", obtener solo empleados trabajando actualmente
    if (filter === 'working') {
      // Obtener registros de asistencia activos (con check-in pero sin check-out)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = new Date(today);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);
      
      const { data: activeRecords, error: recordsError } = await supabase
        .from('attendance_records')
        .select(`
          employee_id,
          check_in_time,
          check_out_time,
          branch_id,
          branch:branches(id, name)
        `)
        .eq('business_id', businessId)
        .not('check_in_time', 'is', null)
        .is('check_out_time', null)
        .gte('check_in_time', todayStart.toISOString())
        .lte('check_in_time', todayEnd.toISOString());
      
      if (recordsError) {
        console.error('Error fetching active records:', recordsError);
      }
      
      const activeEmployeeIds = new Set((activeRecords || []).map((r: any) => r.employee_id));
      
      if (activeEmployeeIds.size === 0) {
        return withCors(origin, Response.json({
          employees: [],
          total: 0,
          max_allowed: 0,
        }));
      }
      
      // Obtener empleados activos que están trabajando
      const { data: employees } = await supabase
        .from('employees')
        .select(`
          *,
          employee_branches(
            branch:branches(id, name),
            employees_hours_start,
            employees_hours_end,
            tolerance_minutes
          )
        `)
        .eq('business_id', businessId)
        .eq('status', 'active')
        .in('id', Array.from(activeEmployeeIds))
        .order('created_at', { ascending: false });
      
      // Crear mapa de employee_id -> registro de asistencia activo
      const activeRecordMap = new Map();
      (activeRecords || []).forEach((r: any) => {
        if (!activeRecordMap.has(r.employee_id)) {
          activeRecordMap.set(r.employee_id, r);
        }
      });
      
      // Transformar empleados con información de asistencia
      const employeesWithAttendance = (employees || []).map((emp: any) => {
        const activeRecord = activeRecordMap.get(emp.id);
        const checkInTime = activeRecord?.check_in_time ? new Date(activeRecord.check_in_time) : null;
        const now = new Date();
        const durationMs = checkInTime ? now.getTime() - checkInTime.getTime() : 0;
        const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
        const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
        const durationFormatted = `${durationHours}h ${durationMinutes}m`;
        
        return {
          ...emp,
          current_branch: activeRecord?.branch ? {
            id: activeRecord.branch.id,
            name: activeRecord.branch.name,
          } : null,
          check_in_time: activeRecord?.check_in_time || null,
          duration: durationFormatted,
          branches: (emp.employee_branches || [])
            .map((eb: any) => ({
              id: eb.branch?.id,
              name: eb.branch?.name,
              employees_hours_start: eb.employees_hours_start,
              employees_hours_end: eb.employees_hours_end,
              tolerance_minutes: eb.tolerance_minutes,
            }))
            .filter((b: any) => b.id && b.name),
        };
      });
      
      return withCors(origin, Response.json({
        employees: employeesWithAttendance,
        total: employeesWithAttendance.length,
        max_allowed: 0, // No aplica para este filtro
      }));
    }
    
    // Obtener empleados con sus branches y horarios (usando left join para incluir empleados sin branches)
    const { data: employees } = await supabase
      .from('employees')
      .select(`
        *,
        employee_branches(
          branch:branches(id, name),
          employees_hours_start,
          employees_hours_end,
          tolerance_minutes
        )
      `)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });
    
    // Obtener el estado de invitación para cada empleado
    const employeeIds = (employees || []).map((emp: any) => emp.id);
    const { data: invitations } = await supabase
      .from('employee_invitations')
      .select('employee_id, status, expires_at')
      .in('employee_id', employeeIds)
      .order('created_at', { ascending: false });
    
    // Crear un mapa de employee_id -> última invitación
    const invitationMap = new Map<string, { status: string; expires_at: string }>();
    (invitations || []).forEach((inv: any) => {
      if (!invitationMap.has(inv.employee_id)) {
        invitationMap.set(inv.employee_id, {
          status: inv.status,
          expires_at: inv.expires_at,
        });
      }
    });
    
    const nowIso = new Date().toISOString();
    
    // Transformar la respuesta para que sea más fácil de usar en el frontend
    const employeesWithBranches = (employees || []).map((emp: any) => {
      const lastInvitation = invitationMap.get(emp.id);
      let invitationStatus: 'accepted' | 'pending' | 'expired' = 'accepted';
      
      if (lastInvitation) {
        if (lastInvitation.status === 'pending') {
          // Verificar si está expirada
          if (lastInvitation.expires_at <= nowIso) {
            invitationStatus = 'expired';
          } else {
            invitationStatus = 'pending';
          }
        } else if (lastInvitation.status === 'accepted') {
          invitationStatus = 'accepted';
        } else {
          invitationStatus = 'expired';
        }
      } else if (emp.status === 'pending') {
        // Si no hay invitación pero el empleado está pendiente, asumir que expiró
        invitationStatus = 'expired';
      }
      
      return {
        ...emp,
        invitation_status: invitationStatus,
        branches: (emp.employee_branches || [])
          .map((eb: any) => ({
            id: eb.branch?.id,
            name: eb.branch?.name,
            employees_hours_start: eb.employees_hours_start,
            employees_hours_end: eb.employees_hours_end,
            tolerance_minutes: eb.tolerance_minutes,
          }))
          .filter((b: any) => b.id && b.name),
      };
    });
    
    // Calcular total y max_allowed para la respuesta
    const activeCount = employeesWithBranches.filter((e: any) => e.status === 'active').length;
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('tier:subscription_tiers(max_employees)')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .single();
    
    const tier = subscription?.tier && !Array.isArray(subscription.tier) 
      ? subscription.tier as { max_employees?: number }
      : null;
    const maxAllowed = tier?.max_employees || 0;
    
    return withCors(origin, Response.json({ 
      employees: employeesWithBranches,
      total: activeCount,
      max_allowed: maxAllowed,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const body = await request.json();
    const payload = employeeSchema.parse(body);

    const supabase = createServiceRoleClient();
    
    // Verificar si ya existe un empleado con ese teléfono en este negocio
    const { data: existingEmployee } = await supabase
      .from('employees')
      .select('id, full_name, phone, status')
      .eq('business_id', businessId)
      .eq('phone', payload.phone)
      .maybeSingle();
    
    if (existingEmployee) {
      // Verificar si tiene una invitación pendiente válida
      const { data: existingInvitation } = await supabase
        .from('employee_invitations')
        .select('id, status, expires_at')
        .eq('employee_id', existingEmployee.id)
        .eq('status', 'pending')
        .gte('expires_at', new Date().toISOString())
        .maybeSingle();
      
      if (existingInvitation) {
        return withCors(origin, Response.json(
          { 
            error: 'Ya existe una invitación pendiente para este número',
            code: 'PENDING_INVITATION',
            message: `Ya existe una invitación pendiente para el teléfono ${payload.phone}. Por favor espera a que expire o reenvía la invitación desde la lista de empleados.`,
            existing_employee: {
              id: existingEmployee.id,
              full_name: existingEmployee.full_name,
              status: existingEmployee.status,
            }
          },
          { status: 409 }
        ));
      }
      
      return withCors(origin, Response.json(
        { 
          error: 'Ya existe un empleado con este número de teléfono',
          code: 'DUPLICATE_PHONE',
          message: `Ya existe un empleado con el teléfono ${payload.phone} en tu negocio.`,
          existing_employee: {
            id: existingEmployee.id,
            full_name: existingEmployee.full_name,
            status: existingEmployee.status,
          }
        },
        { status: 409 }
      ));
    }
    
    const limits = await validatePlanLimits(supabase, businessId, 'employees');
    if (!limits.allowed) throw new PlanLimitError('employees', limits.current, limits.max);

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
    if (!isPremium && payload.branch_hours && Object.keys(payload.branch_hours).length > 0) {
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
    if (isPremium && payload.branch_hours) {
      for (const [branchId, hours] of Object.entries(payload.branch_hours)) {
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

    // Assign system number
    const assignedSystemNumber = await assignSystemNumberToEmployee();

    // Prepare employee data
    const employeeData: any = {
      business_id: businessId,
      full_name: payload.full_name,
      phone: payload.phone,
      hourly_rate: payload.hourly_rate,
      status: 'pending',
    };

    // Add system number if assigned
    if (assignedSystemNumber) {
      employeeData.system_number_registered = assignedSystemNumber;
    }

    // branch_hours se guardará en employee_invitations, no en employees

    const { data: employee, error: insertError } = await supabase
      .from('employees')
      .insert(employeeData)
      .select()
      .single();

    if (insertError || !employee) {
      console.error('Error inserting employee:', insertError);
      throw new Error(insertError?.message || 'Error al crear empleado');
    }

    // NO crear employee_branches aquí - se crearán solo cuando el empleado acepte la invitación
    // Obtener información de las branches para la respuesta (solo para mostrar en el mensaje)
    let branchesData: Array<{ id: string; name: string }> = [];
    if (payload.branch_ids?.length) {
      // Obtener los nombres de las branches para el mensaje de WhatsApp
      const { data: branches } = await supabase
        .from('branches')
        .select('id, name')
        .in('id', payload.branch_ids);
      
      branchesData = (branches || []).map((b: any) => ({ id: b.id, name: b.name }));
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // Guardar branch_ids y branch_hours en el invitation como JSONB para crear las relaciones cuando acepte
    const invitationData: any = {
      employee_id: employee.id, 
      token, 
      expires_at: expiresAt,
      branch_ids: payload.branch_ids || [], // Guardar como JSONB
    };
    
    // Guardar branch_hours si es premium y están presentes
    if (isPremium && payload.branch_hours && Object.keys(payload.branch_hours).length > 0) {
      invitationData.branch_hours = payload.branch_hours;
    }
    
    await supabase.from('employee_invitations').insert(invitationData);

    // Send WhatsApp invitation via Meta Template Message API
    try {
      const { data: business } = await supabase
        .from('businesses')
        .select('name')
        .eq('id', businessId)
        .single();
      
      const { data: branches } = await supabase
        .from('branches')
        .select('name')
        .in('id', payload.branch_ids || []);

      // Meta solo permite una variable al final de la URL
      // Usamos formato: /invite/{token} donde el token es único y contiene toda la info necesaria
      const invitationUrl = `${process.env.FRONTEND_URL}/invite/${token}`;
      
      // Obtener credenciales del número asignado si existe
      let systemNumberCredentials: { jwtToken: string; numberId: string } | undefined;
      if (assignedSystemNumber) {
        const systemNumber = await getSystemNumberCredentials(assignedSystemNumber);
        if (systemNumber) {
          systemNumberCredentials = {
            jwtToken: systemNumber.meta_jwt_token,
            numberId: systemNumber.meta_number_id,
          };
        }
      }
      
      // Importar función de envío de plantilla
      const { sendEmployeeInvitation } = await import('@/lib/meta/template-messages');
      
      const result = await sendEmployeeInvitation({
        phone: employee.phone,
        employeeName: employee.full_name,
        businessName: business?.name || 'Tu Negocio',
        branches: (branches || []).map((b: any) => b.name),
        invitationUrl,
        templateName: 'employee_invitation', // Nombre de la plantilla en Meta
      }, systemNumberCredentials);

      if (!result.success) {
        console.error('Error al enviar invitación por WhatsApp:', result.error);
        // No fallar la creación del empleado si falla el envío del mensaje
      } else {
        console.log(`✅ Invitación enviada exitosamente a ${employee.phone}`);
      }
    } catch (e: any) {
      console.error('Failed to send WhatsApp invitation:', e.message || e);
      // No fallar la creación del empleado si falla el envío del mensaje
    }

    // Construir link de invitación
    // Meta solo permite una variable al final de la URL, por eso usamos /invite/{token}
    const invitationLink = `${process.env.FRONTEND_URL}/invite/${token}`;

    return withCors(origin, Response.json({
      ...employee,
      branches: branchesData,
      invitation_sent: true,
      invitation_link: invitationLink,
      system_number: assignedSystemNumber, // Include assigned system number in response
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







