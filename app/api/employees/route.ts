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
      start: z.union([
        z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
        z.literal(''),
      ]).optional(),
      end: z.union([
        z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
        z.literal(''),
      ]).optional(),
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
    
    // Transformar la respuesta para que sea más fácil de usar en el frontend
    const employeesWithBranches = (employees || []).map((emp: any) => ({
      ...emp,
      branches: (emp.employee_branches || [])
        .map((eb: any) => ({
          id: eb.branch?.id,
          name: eb.branch?.name,
          employees_hours_start: eb.employees_hours_start,
          employees_hours_end: eb.employees_hours_end,
          tolerance_minutes: eb.tolerance_minutes,
        }))
        .filter((b: any) => b.id && b.name),
    }));
    
    return withCors(origin, Response.json({ employees: employeesWithBranches }));
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
        // Si se proporciona start o end, ambos deben estar presentes
        if ((h.start && !h.end) || (!h.start && h.end)) {
          return withCors(origin, Response.json(
            {
              error: 'Validation error',
              code: 'VALIDATION_ERROR',
              message: `Para la sucursal ${branchId}, si especificas un horario, debes proporcionar tanto la hora de inicio como la de fin.`,
            },
            { status: 400 }
          ));
        }
        
        // Si ambos están presentes, validar que start < end
        if (h.start && h.end) {
          const [startHour, startMin] = h.start.split(':').map(Number);
          const [endHour, endMin] = h.end.split(':').map(Number);
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







