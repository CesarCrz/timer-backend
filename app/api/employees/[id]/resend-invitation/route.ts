import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError } from '@/lib/utils/errors';
import { getSystemNumberCredentials } from '@/lib/utils/system-numbers';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const employeeId = id;
    const supabase = createServiceRoleClient();

    const { data: employee } = await supabase
      .from('employees')
      .select('id, business_id, full_name, phone, system_number_registered')
      .eq('id', employeeId)
      .single();
    if (!employee || employee.business_id !== businessId) throw new NotFoundError('Employee');

    // Obtener branch_ids del empleado (desde employee_branches existentes o desde la última invitación pendiente)
    const { data: employeeBranches } = await supabase
      .from('employee_branches')
      .select('branch_id')
      .eq('employee_id', employeeId)
      .eq('status', 'active');
    
    const branchIds = (employeeBranches || []).map((eb: any) => eb.branch_id);
    
    // Si no hay branches activas, intentar obtener desde la última invitación pendiente
    let invitationBranchIds = branchIds;
    if (branchIds.length === 0) {
      const { data: lastInvitation } = await supabase
        .from('employee_invitations')
        .select('branch_ids')
        .eq('employee_id', employeeId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (lastInvitation?.branch_ids) {
        invitationBranchIds = lastInvitation.branch_ids;
      }
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('employee_invitations')
      .insert({ 
        employee_id: employeeId, 
        token, 
        expires_at: expiresAt,
        branch_ids: invitationBranchIds // Guardar branch_ids como JSONB
      });

    const { data: branches } = await supabase
      .from('branches')
      .select('id, name')
      .in('id', invitationBranchIds.length > 0 ? invitationBranchIds : ['00000000-0000-0000-0000-000000000000']);

    const { data: business } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .single();

      const invitationUrl = `${process.env.FRONTEND_URL}/invite/${token}`;
      
      // Obtener credenciales del número asignado si existe
      let systemNumberCredentials: { jwtToken: string; numberId: string } | undefined;
      if (employee.system_number_registered) {
        const systemNumber = await getSystemNumberCredentials(employee.system_number_registered);
        if (systemNumber) {
          systemNumberCredentials = {
            jwtToken: systemNumber.meta_jwt_token,
            numberId: systemNumber.meta_number_id,
          };
        }
      }
      
      // Usar la función sendEmployeeInvitation que maneja mejor los errores y usa la API de Meta
      const { sendEmployeeInvitation } = await import('@/lib/meta/template-messages');
      
      console.log(`📤 [RESEND] Intentando reenviar invitación a ${employee.full_name} (${employee.phone})`);
      console.log(`📋 [RESEND] URL de invitación: ${invitationUrl}`);
      console.log(`📋 [RESEND] Sucursales: ${(branches || []).map((b: any) => b.name).filter(Boolean).join(', ')}`);
      console.log(`📱 [RESEND] Número asignado: ${employee.system_number_registered || 'N/A'}`);
      
      const result = await sendEmployeeInvitation({
        phone: employee.phone,
        employeeName: employee.full_name,
        businessName: business?.name || 'Tu Negocio',
        branches: (branches || []).map((b: any) => b.name),
        invitationUrl,
        templateName: 'employee_invitation',
      }, systemNumberCredentials);

      if (!result.success) {
        console.error(`❌ [RESEND] Error al reenviar invitación por WhatsApp`);
        console.error(`❌ [RESEND] Error:`, result.error);
        console.error(`❌ [RESEND] Error Code:`, result.errorCode);
        console.error(`❌ [RESEND] Error Type:`, result.errorType);
        console.error(`❌ [RESEND] Detalles completos:`, JSON.stringify(result, null, 2));
        
        return withCors(origin, Response.json({ 
          ok: false, 
          error: result.error || 'Error al enviar mensaje por WhatsApp',
          errorCode: result.errorCode,
          errorType: result.errorType,
          message: `No se pudo enviar la invitación: ${result.error || 'Error desconocido'}`,
          details: result
        }, { status: 500 }));
      }

      console.log(`✅ [RESEND] Invitación reenviada exitosamente a ${employee.phone}`);
      console.log(`📨 [RESEND] Message ID: ${result.messageId || 'N/A'}`);

    return withCors(origin, Response.json({ 
      ok: true, 
      messageId: result.messageId,
      message: 'Invitación reenviada exitosamente'
    }));
  } catch (error) {
    return handleApiError(error);
  }
}







