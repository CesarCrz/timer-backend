import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError, PlanLimitError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

/**
 * PUT /api/employees/[id]/activate
 * Reactiva un empleado desactivado
 * Valida límites de plan antes de reactivar (permite activar uno por uno hasta el límite)
 */
export async function PUT(request: Request, ctx: { params: { id: string } }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const employeeId = ctx.params.id;

    const supabase = createServiceRoleClient();

    // Verificar que el empleado existe y pertenece al negocio
    const { data: employee } = await supabase
      .from('employees')
      .select('id, business_id, status')
      .eq('id', employeeId)
      .single();

    if (!employee || employee.business_id !== businessId) {
      throw new NotFoundError('Employee');
    }

    if (employee.status === 'active') {
      return withCors(origin, Response.json(
        { error: 'El empleado ya está activo' },
        { status: 400 }
      ));
    }

    // Obtener suscripción activa
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('tier_id')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .single();

    if (!subscription) {
      return withCors(origin, Response.json(
        { error: 'No tienes una suscripción activa', code: 'NO_SUBSCRIPTION' },
        { status: 402 }
      ));
    }

    // Obtener límites del plan
    const { data: tier } = await supabase
      .from('subscription_tiers')
      .select('max_employees')
      .eq('id', subscription.tier_id)
      .single();

    if (!tier) {
      return withCors(origin, Response.json(
        { error: 'Plan no encontrado' },
        { status: 404 }
      ));
    }

    // Contar empleados activos actuales
    const { count: activeEmployeesCount } = await supabase
      .from('employees')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    // Validar límite de empleados (permitir activar uno por uno hasta el límite)
    if ((activeEmployeesCount || 0) >= tier.max_employees) {
      throw new PlanLimitError(
        'employees',
        activeEmployeesCount || 0,
        tier.max_employees
      );
    }

    // Reactivar el empleado
    await supabase
      .from('employees')
      .update({ status: 'active' })
      .eq('id', employeeId);

    // Reactivar todas las relaciones employee_branches para este empleado
    await supabase
      .from('employee_branches')
      .update({ status: 'active' })
      .eq('employee_id', employeeId)
      .eq('status', 'inactive');

    return withCors(origin, Response.json({
      message: 'Employee activated successfully',
      id: employeeId,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

