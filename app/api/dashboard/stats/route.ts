import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';

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

    // Obtener fecha de hoy
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    // Obtener IDs de empleados activos del negocio
    const { data: activeEmployeeIds } = await supabase
      .from('employees')
      .select('id')
      .eq('business_id', businessId)
      .eq('status', 'active');

    const employeeIds = activeEmployeeIds?.map(e => e.id) || [];

    // Empleados activos hoy (check-ins sin check-out)
    const { count: activeEmployees } = employeeIds.length > 0 ? await supabase
      .from('attendance_records')
      .select('id', { count: 'exact' })
      .eq('status', 'active')
      .gte('check_in_time', today.toISOString())
      .lte('check_in_time', todayEnd.toISOString())
      .in('employee_id', employeeIds) : { count: 0 };

    // Total de empleados activos
    const { count: totalEmployees } = await supabase
      .from('employees')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    // Llegadas tarde hoy (simplificado - contamos registros completados hoy)
    // TODO: Implementar lógica real de tardanza basada en business_hours_start
    const { count: lateArrivals } = employeeIds.length > 0 ? await supabase
      .from('attendance_records')
      .select('id', { count: 'exact' })
      .gte('check_in_time', today.toISOString())
      .lte('check_in_time', todayEnd.toISOString())
      .eq('status', 'completed')
      .in('employee_id', employeeIds) : { count: 0 };

    // Empleados activos ahora (check-ins sin check-out)
    const { data: activeNow } = employeeIds.length > 0 ? await supabase
      .from('attendance_records')
      .select(`
        id,
        check_in_time,
        employee:employees(id, full_name),
        branch:branches(id, name)
      `)
      .eq('status', 'active')
      .in('employee_id', employeeIds)
      .limit(10) : { data: [] };

    // Datos semanales simplificados (últimos 7 días)
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 7);
    
    const weeklyChart = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);

      const { count: completed } = await supabase
        .from('attendance_records')
        .select('id', { count: 'exact' })
        .eq('status', 'completed')
        .gte('check_in_time', dayStart.toISOString())
        .lte('check_in_time', dayEnd.toISOString());

      weeklyChart.push({
        day: date.toLocaleDateString('es-MX', { weekday: 'short' }),
        on_time: completed || 0,
        late: 0, // Simplificado por ahora
        absent: 0, // Simplificado por ahora
      });
    }

    return withCors(origin, Response.json({
      today: {
        active_employees: activeEmployees || 0,
        late_arrivals: lateArrivals || 0,
        total_employees: totalEmployees || 0,
      },
      weekly_chart: weeklyChart,
      active_now: (activeNow || []).map((record: any) => ({
        id: record.id,
        name: record.employee?.full_name || 'Empleado',
        branch: record.branch?.name || 'Sucursal',
        check_in_time: record.check_in_time,
      })),
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

