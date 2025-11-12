import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError, NotFoundError, PlanLimitError } from '@/lib/utils/errors';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

/**
 * PUT /api/branches/[id]/activate
 * Reactiva una sucursal desactivada
 * Valida límites de plan antes de reactivar
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const { id } = await ctx.params;
    const branchId = id;

    const supabase = createServiceRoleClient();

    // Verificar que la sucursal existe y pertenece al negocio
    const { data: branch } = await supabase
      .from('branches')
      .select('id, business_id, status')
      .eq('id', branchId)
      .single();

    if (!branch || branch.business_id !== businessId) {
      throw new NotFoundError('Branch');
    }

    if (branch.status === 'active') {
      return withCors(origin, Response.json(
        { error: 'La sucursal ya está activa' },
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
      .select('max_branches, max_employees')
      .eq('id', subscription.tier_id)
      .single();

    if (!tier) {
      return withCors(origin, Response.json(
        { error: 'Plan no encontrado' },
        { status: 404 }
      ));
    }

    // Contar sucursales activas actuales
    const { count: activeBranchesCount } = await supabase
      .from('branches')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    // Validar límite de sucursales
    if ((activeBranchesCount || 0) >= tier.max_branches) {
      throw new PlanLimitError(
        'branches',
        activeBranchesCount || 0,
        tier.max_branches
      );
    }

    // Obtener empleados que se reactivarían al reactivar esta sucursal
    // (empleados que tienen relación inactive con esta sucursal Y que están inactivos en employees)
    const { data: employeesToReactivate } = await supabase
      .from('employee_branches')
      .select('employee_id, employee:employees(id, status)')
      .eq('branch_id', branchId)
      .eq('status', 'inactive');

    // Filtrar solo empleados que están inactivos (no activos en otra sucursal)
    const employeeIdsToReactivate = (employeesToReactivate || [])
      .filter((eb: any) => eb.employee?.status === 'inactive')
      .map((eb: any) => eb.employee_id);

    // Contar empleados activos actuales (en todas las sucursales)
    const { count: activeEmployeesCount } = await supabase
      .from('employees')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    // Obtener empleados únicos que se reactivarían (pueden estar en múltiples sucursales)
    const uniqueEmployeeIds = [...new Set(employeeIdsToReactivate)];

    // Verificar si reactivar esta sucursal excedería el límite de empleados
    const totalEmployeesAfterReactivate = (activeEmployeesCount || 0) + uniqueEmployeeIds.length;

    if (totalEmployeesAfterReactivate > tier.max_employees) {
      return withCors(origin, Response.json(
        {
          error: `No se puede reactivar esta sucursal. Reactivarla activaría ${uniqueEmployeeIds.length} empleado(s) adicional(es), lo que excedería tu límite de ${tier.max_employees} empleados. Actualmente tienes ${activeEmployeesCount || 0} empleados activos.`,
          code: 'PLAN_LIMIT_EXCEEDED',
          current_employees: activeEmployeesCount || 0,
          employees_to_reactivate: uniqueEmployeeIds.length,
          max_employees: tier.max_employees,
        },
        { status: 403 }
      ));
    }

    // Reactivar la sucursal
    await supabase
      .from('branches')
      .update({ status: 'active' })
      .eq('id', branchId);

    // Reactivar las relaciones employee_branches para esta sucursal
    if (employeeIdsToReactivate.length > 0) {
      // Reactivar las relaciones employee_branches
      await supabase
        .from('employee_branches')
        .update({ status: 'active' })
        .eq('branch_id', branchId)
        .eq('status', 'inactive');
      
      // Reactivar los empleados en la tabla employees (solo los que están inactivos)
      await supabase
        .from('employees')
        .update({ status: 'active' })
        .in('id', uniqueEmployeeIds)
        .eq('status', 'inactive');
    }

    return withCors(origin, Response.json({
      message: 'Branch activated successfully',
      id: branchId,
      employees_reactivated: uniqueEmployeeIds.length,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

