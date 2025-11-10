import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, PlanLimitError } from '@/lib/utils/errors';
import { validatePlanLimits } from '@/lib/utils/validation';

const employeeSchema = z.object({
  full_name: z.string().min(3).max(100),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  hourly_rate: z.number().positive().max(10000),
  branch_ids: z.array(z.string().uuid()).min(1),
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
    
    // Obtener empleados con sus branches (usando left join para incluir empleados sin branches)
    const { data: employees } = await supabase
      .from('employees')
      .select(`
        *,
        employee_branches(
          branch:branches(id, name)
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

    const { data: employee, error: insertError } = await supabase
      .from('employees')
      .insert({
        business_id: businessId,
        full_name: payload.full_name,
        phone: payload.phone,
        hourly_rate: payload.hourly_rate,
        status: 'pending',
      })
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
    // Guardar branch_ids en el invitation como JSONB para crear las relaciones cuando acepte
    await supabase.from('employee_invitations').insert({ 
      employee_id: employee.id, 
      token, 
      expires_at: expiresAt,
      branch_ids: payload.branch_ids || [] // Guardar como JSONB
    });

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
      
      // Importar función de envío de plantilla
      const { sendEmployeeInvitation } = await import('@/lib/meta/template-messages');
      
      const result = await sendEmployeeInvitation({
        phone: employee.phone,
        employeeName: employee.full_name,
        businessName: business?.name || 'Tu Negocio',
        branches: (branches || []).map((b: any) => b.name),
        invitationUrl,
        templateName: 'employee_invitation', // Nombre de la plantilla en Meta
      });

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
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







