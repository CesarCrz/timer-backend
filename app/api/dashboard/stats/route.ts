import { withCors, preflight } from '@/lib/utils/cors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { handleApiError } from '@/lib/utils/errors';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

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
      .not('check_in_time', 'is', null)
      .is('check_out_time', null)
      .gte('check_in_time', today.toISOString())
      .lte('check_in_time', todayEnd.toISOString())
      .in('employee_id', employeeIds) : { count: 0 };

    // Total de empleados activos
    const { count: totalEmployees } = await supabase
      .from('employees')
      .select('id', { count: 'exact' })
      .eq('business_id', businessId)
      .eq('status', 'active');

    // Llegadas tarde hoy - usar campo is_late de attendance_records
    const { count: lateArrivalsCount } = employeeIds.length > 0 ? await supabase
      .from('attendance_records')
      .select('id', { count: 'exact' })
      .eq('is_late', true)
      .gte('check_in_time', today.toISOString())
      .lte('check_in_time', todayEnd.toISOString())
      .in('employee_id', employeeIds) : { count: 0 };

    // Empleados activos ahora (check-ins sin check-out)
    const { data: activeNow } = employeeIds.length > 0 ? await supabase
      .from('attendance_records')
      .select(`
        id,
        check_in_time,
        employee:employees(id, full_name),
        branch:branches(id, name, timezone)
      `)
      .not('check_in_time', 'is', null)
      .is('check_out_time', null)
      .gte('check_in_time', today.toISOString())
      .lte('check_in_time', todayEnd.toISOString())
      .in('employee_id', employeeIds)
      .order('check_in_time', { ascending: false })
      .limit(10) : { data: [] };

    // Datos semanales (últimos 7 días) - calcular on_time, late, absent
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

      const { data: dayRecords } = await supabase
        .from('attendance_records')
        .select('id, is_late')
        .gte('check_in_time', dayStart.toISOString())
        .lte('check_in_time', dayEnd.toISOString())
        .in('employee_id', employeeIds.length > 0 ? employeeIds : ['00000000-0000-0000-0000-000000000000']); // Si no hay empleados, usar UUID inválido para que no retorne nada

      let onTime = 0;
      let late = 0;
      
      if (dayRecords) {
        for (const record of dayRecords) {
          if (record.is_late === true) {
            late++;
          } else {
            onTime++;
          }
        }
      }
      
      // Absent = empleados activos - (on_time + late)
      const absent = Math.max(0, (totalEmployees || 0) - (onTime + late));

      weeklyChart.push({
        day: date.toLocaleDateString('es-MX', { weekday: 'short' }),
        on_time: onTime,
        late: late,
        absent: absent,
      });
    }

    return withCors(origin, Response.json({
      today: {
        active_employees: activeEmployees || 0,
        late_arrivals: lateArrivalsCount,
        total_employees: totalEmployees || 0,
      },
      weekly_chart: weeklyChart,
      active_now: (activeNow || []).map((record: any) => {
        if (!record.check_in_time) {
          return {
            id: record.id,
            name: record.employee?.full_name || 'Empleado',
            branch: record.branch?.name || 'Sucursal',
            check_in_time: '-',
            duration: '-',
          };
        }
        
        const branchTimezone = record.branch?.timezone || 'America/Mexico_City';
        const checkInTime = dayjs.utc(record.check_in_time).tz(branchTimezone);
        const now = dayjs().tz(branchTimezone);
        const durationMinutes = now.diff(checkInTime, 'minute');
        const hours = Math.floor(durationMinutes / 60);
        const minutes = durationMinutes % 60;
        const durationFormatted = `${hours}h ${minutes}m`;
        
        return {
          id: record.id,
          name: record.employee?.full_name || 'Empleado',
          branch: record.branch?.name || 'Sucursal',
          check_in_time: checkInTime.isValid() ? checkInTime.format('hh:mm A') : '-',
          duration: durationFormatted,
        };
      }),
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

