import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError, UnauthorizedError } from '@/lib/utils/errors';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { calculateDistance } from '@/lib/geolocation/haversine';
import { limiter } from '@/lib/utils/rate-limit';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const bodySchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  action: z.enum(['check_in', 'check_out']).optional(), // Opcional: se determina automáticamente si no se proporciona
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    try {
      await limiter.check(100, ip);
    } catch {
      return withCors(origin, Response.json({ error: 'Rate limit exceeded' }, { status: 429 }));
    }

    const authHeader = request.headers.get('authorization');
    if (!authHeader || authHeader !== `Bearer ${process.env.BUILDERBOT_API_SECRET}`) {
      throw new UnauthorizedError('Invalid API secret');
    }

    const body = await request.json();
    const { phone, latitude, longitude, action: providedAction } = bodySchema.parse(body);

    console.log('🔍 [VALIDATE] ============================================');
    console.log('🔍 [VALIDATE] Iniciando validación de asistencia');
    console.log('🔍 [VALIDATE] Teléfono recibido:', phone);
    console.log('🔍 [VALIDATE] Coordenadas recibidas:', { latitude, longitude });
    console.log('🔍 [VALIDATE] Acción proporcionada:', providedAction || 'AUTO');

    const supabase = createServiceRoleClient();

    // 1) Buscar TODOS los empleados activos con este teléfono (pueden ser de diferentes negocios)
    console.log('🔍 [VALIDATE] Buscando TODOS los empleados activos con teléfono:', phone);
    const { data: allEmployees, error: employeeError } = await supabase
      .from('employees')
      .select('id, status, full_name, phone, business_id, created_at')
      .eq('phone', phone)
      .eq('status', 'active');

    if (employeeError) {
      console.error('❌ [VALIDATE] Error al buscar empleados:', employeeError);
    }

    console.log('🔍 [VALIDATE] Empleados activos encontrados:', allEmployees?.length || 0);
    if (allEmployees && allEmployees.length > 0) {
      console.log('🔍 [VALIDATE] Detalle de empleados:', allEmployees.map((e: any) => ({
        id: e.id,
        name: e.full_name,
        business_id: e.business_id,
        created_at: e.created_at
      })));
    }

    if (!allEmployees || allEmployees.length === 0) {
      console.log('❌ [VALIDATE] ERROR: No se encontraron empleados activos con este teléfono');
      return withCors(origin, Response.json({ valid: false, message: 'Empleado no encontrado o inactivo' }));
    }

    // 2) Para cada empleado, obtener TODAS sus sucursales activas (sin filtrar por radio todavía)
    // Construir un array de todas las sucursales de todos los empleados
    interface BranchCandidate {
      employee: any;
      branch: any;
      employeeBranch: any;
      distance: number;
    }

    const allBranchCandidates: BranchCandidate[] = [];

    for (const employee of allEmployees) {
      console.log(`🔍 [VALIDATE] Procesando empleado ${employee.full_name} (${employee.id})`);
      
      // Obtener sucursales asignadas activas para este empleado
      const { data: employeeBranches, error: employeeBranchesError } = await supabase
        .from('employee_branches')
        .select('branch_id, status, employees_hours_start, employees_hours_end, tolerance_minutes')
        .eq('employee_id', employee.id)
        .eq('status', 'active');

      if (employeeBranchesError) {
        console.error(`❌ [VALIDATE] Error al buscar sucursales para empleado ${employee.id}:`, employeeBranchesError);
        continue;
      }

      const activeBranchIds = (employeeBranches || [])
        .filter((eb: any) => eb.status === 'active')
        .map((eb: any) => eb.branch_id);

      if (activeBranchIds.length === 0) {
        console.log(`⚠️ [VALIDATE] Empleado ${employee.full_name} no tiene sucursales activas asignadas`);
        continue;
      }

      // Obtener detalles de las sucursales activas
      const { data: branches, error: branchesError } = await supabase
        .from('branches')
        .select('id, name, latitude, longitude, tolerance_radius_meters, timezone, business_hours_start, tolerance_minutes, status')
        .in('id', activeBranchIds)
        .eq('status', 'active');

      if (branchesError) {
        console.error(`❌ [VALIDATE] Error al buscar sucursales para empleado ${employee.id}:`, branchesError);
        continue;
      }

      // Calcular distancia a cada sucursal (SIN filtrar por radio todavía)
      (branches || []).forEach((branch: any) => {
        const distance = calculateDistance(latitude, longitude, Number(branch.latitude), Number(branch.longitude));
        
        console.log(`🔍 [VALIDATE] Empleado ${employee.full_name} - Sucursal ${branch.name}: distancia=${distance.toFixed(2)}m, radio permitido=${branch.tolerance_radius_meters}m`);
        
        // Encontrar el employee_branch correspondiente para obtener horarios específicos
        const employeeBranch = (employeeBranches || []).find((eb: any) => eb.branch_id === branch.id);
        allBranchCandidates.push({
          employee,
          branch,
          employeeBranch: employeeBranch || null,
          distance
        });
      });
    }

    console.log('🔍 [VALIDATE] Total de sucursales encontradas (de todos los empleados):', allBranchCandidates.length);

    if (allBranchCandidates.length === 0) {
      console.log('❌ [VALIDATE] ERROR: No tienes sucursales activas asignadas en ningún empleado');
      return withCors(origin, Response.json({
        valid: false,
        message: 'No tienes sucursales activas asignadas',
      }));
    }

    // 3) Seleccionar la sucursal MÁS CERCANA de todas (sin importar el radio todavía)
    const closestCandidate = allBranchCandidates.reduce((closest, candidate) => {
      return candidate.distance < closest.distance ? candidate : closest;
    });

    const employee = closestCandidate.employee;
    const closest = { branch: closestCandidate.branch, distance: closestCandidate.distance };
    const employeeBranch = closestCandidate.employeeBranch;

    console.log('✅ [VALIDATE] Sucursal MÁS CERCANA seleccionada:', {
      empleado: employee.full_name,
      empleado_id: employee.id,
      negocio_id: employee.business_id,
      sucursal: closest.branch.name,
      sucursal_id: closest.branch.id,
      distancia: closest.distance.toFixed(2) + 'm',
      radio_permitido: closest.branch.tolerance_radius_meters + 'm'
    });

    // 4) VALIDAR si la sucursal más cercana está dentro del radio permitido
    const isWithinRadius = closest.distance <= Number(closest.branch.tolerance_radius_meters);
    
    console.log(`🔍 [VALIDATE] Validación de radio: distancia=${closest.distance.toFixed(2)}m, radio permitido=${closest.branch.tolerance_radius_meters}m, dentro del radio=${isWithinRadius}`);

    if (!isWithinRadius) {
      console.log('❌ [VALIDATE] ERROR: La sucursal más cercana está fuera del radio permitido');
      console.log('🔍 [VALIDATE] Detalle:', {
        sucursal: closest.branch.name,
        distancia: closest.distance.toFixed(2) + 'm',
        radio_permitido: closest.branch.tolerance_radius_meters + 'm',
        diferencia: (closest.distance - Number(closest.branch.tolerance_radius_meters)).toFixed(2) + 'm fuera del radio'
      });
      return withCors(origin, Response.json({
        valid: false,
        message: `No estás dentro del radio permitido de la sucursal más cercana (${closest.branch.name}). Estás a ${closest.distance.toFixed(0)}m y el radio permitido es ${closest.branch.tolerance_radius_meters}m.`,
      }));
    }

    console.log('✅ [VALIDATE] Validación exitosa: La sucursal más cercana está dentro del radio permitido');

    console.log('✅ [VALIDATE] Sucursal más cercana seleccionada:', {
      empleado: employee.full_name,
      empleado_id: employee.id,
      negocio_id: employee.business_id,
      sucursal: closest.branch.name,
      sucursal_id: closest.branch.id,
      distancia: closest.distance.toFixed(2) + 'm'
    });

    // 4) Determinar automáticamente la acción si no se proporciona
    let action = providedAction;
    if (!action) {
      // Buscar registro activo del día de hoy para este empleado específico
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const { data: activeRecord } = await supabase
        .from('attendance_records')
        .select('id, check_in_time, check_in_latitude, check_in_longitude, check_out_time')
        .eq('employee_id', employee.id)
        .eq('status', 'active')
        .gte('check_in_time', todayStart.toISOString())
        .lte('check_in_time', todayEnd.toISOString())
        .maybeSingle();

      // Si no hay registro activo para hoy O no tiene check_in_time/lat/long → check_in
      // Si hay registro activo con check_in_time/lat/long pero sin check_out → check_out
      if (!activeRecord || !activeRecord.check_in_time || !activeRecord.check_in_latitude || !activeRecord.check_in_longitude) {
        action = 'check_in';
      } else if (activeRecord.check_in_time && activeRecord.check_in_latitude && activeRecord.check_in_longitude && !activeRecord.check_out_time) {
        action = 'check_out';
      } else {
        // Si ya tiene check_out, entonces es un nuevo día → check_in
        action = 'check_in';
      }
    }

    // 5) Crear mapa de horarios por branch_id para acceso rápido (solo para la sucursal seleccionada)
    const branchHoursMap = new Map<string, { start: string; end: string; tolerance: number }>();
    if (employeeBranch && employeeBranch.employees_hours_start && employeeBranch.employees_hours_end) {
      branchHoursMap.set(closest.branch.id, {
        start: employeeBranch.employees_hours_start,
        end: employeeBranch.employees_hours_end,
        tolerance: employeeBranch.tolerance_minutes || 0,
      });
    }

    if (action === 'check_in') {
      const { data: activeRecord } = await supabase
        .from('attendance_records')
        .select('id')
        .eq('employee_id', employee.id)
        .eq('status', 'active')
        .maybeSingle();

      if (activeRecord) {
        return withCors(origin, Response.json({ valid: false, message: 'Ya tienes un check-in activo. Marca salida primero.' }));
      }

      // Obtener hora actual y convertir al timezone de la sucursal
      const branchTimezone = closest.branch.timezone || 'America/Mexico_City';
      
      // Obtener hora actual en el timezone de la sucursal
      const nowInBranchTZ = dayjs().tz(branchTimezone);
      
      // Guardar la hora LOCAL de la sucursal con su timezone
      // PostgreSQL TIMESTAMPTZ necesita formato ISO con 'T': 'YYYY-MM-DDTHH:mm:ss+HH:mm'
      // Ejemplo: '2025-11-12T11:20:01-06:00'
      // PostgreSQL convertirá a UTC internamente pero preservará el timezone original
      const timeToSave = nowInBranchTZ.format('YYYY-MM-DDTHH:mm:ss') + nowInBranchTZ.format('Z');
      
      // LOGS PARA DEBUGGING
      console.log('=== CHECK-IN DEBUG ===');
      console.log('Hora actual (servidor):', dayjs().format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('Timezone de sucursal:', branchTimezone);
      console.log('Hora en timezone de sucursal:', nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('Hora que se guardará (con timezone local):', timeToSave);
      console.log('========================');
      
      // Calcular is_late según tolerancia
      // PRIORIDAD: Usar horario del empleado en esta sucursal (employee_branches) si existe, sino usar horario de la sucursal
      let isLate = false;
      let scheduledStart: dayjs.Dayjs | null = null;
      let toleranceMinutes = 0;
      
      // Verificar si el empleado tiene horario específico para esta sucursal
      const employeeBranchHours = branchHoursMap.get(closest.branch.id);
      if (employeeBranchHours) {
        // Usar horario específico del empleado para esta sucursal
        const [startHour, startMinute] = employeeBranchHours.start.split(':');
        scheduledStart = nowInBranchTZ
          .clone()
          .hour(parseInt(startHour))
          .minute(parseInt(startMinute))
          .second(0)
          .millisecond(0);
        
        toleranceMinutes = employeeBranchHours.tolerance;
      } else if (closest.branch.business_hours_start) {
        // Usar horario de la sucursal
        const [startHour, startMinute] = closest.branch.business_hours_start.split(':');
        scheduledStart = nowInBranchTZ
          .clone()
          .hour(parseInt(startHour))
          .minute(parseInt(startMinute))
          .second(0)
          .millisecond(0);
        
        toleranceMinutes = closest.branch.tolerance_minutes || 0;
      }
      
      if (scheduledStart) {
        const allowedStart = scheduledStart.add(toleranceMinutes, 'minute');
        // Si el check-in es después de la hora permitida (apertura + tolerancia), es tarde
        isLate = nowInBranchTZ.isAfter(allowedStart);
      }
      
      const { data: record } = await supabase
        .from('attendance_records')
        .insert({
          employee_id: employee.id,
          branch_id: closest.branch.id,
          check_in_time: timeToSave,
          check_in_latitude: latitude,
          check_in_longitude: longitude,
          is_late: isLate,
          status: 'active',
        })
        .select()
        .single();

      // LOGS POST-INSERT
      console.log('=== POST-INSERT CHECK-IN ===');
      console.log('Registro insertado:', record);
      console.log('check_in_time desde BD (raw):', record.check_in_time);
      console.log('check_in_time desde BD (tipo):', typeof record.check_in_time);
      console.log('check_in_time parseado (UTC):', dayjs(record.check_in_time).utc().format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('check_in_time en timezone de sucursal:', dayjs(record.check_in_time).tz(branchTimezone).format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('VERIFICACIÓN: La hora debería ser:', nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('¿Coinciden?:', dayjs(record.check_in_time).tz(branchTimezone).format('YYYY-MM-DD HH:mm:ss') === nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss'));
      console.log('================================');

      // Formatear hora usando timezone de la sucursal
      // Con TIMESTAMPTZ, PostgreSQL devuelve el timestamp en UTC, pero podemos convertirlo al timezone de la sucursal
      const checkInTime = dayjs(record.check_in_time).tz(branchTimezone);
      const formattedTime = checkInTime.format('hh:mm A');

      return withCors(origin, Response.json({
        valid: true,
        action: 'check_in',
        branch_name: closest.branch.name,
        time: record.check_in_time,
        timezone: branchTimezone,
        message: `✅ Check-in registrado en ${closest.branch.name} a las ${formattedTime}`,
      }));
    }

    if (action === 'check_out') {
      const { data: activeRecord } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('employee_id', employee.id)
        .eq('status', 'active')
        .maybeSingle();

      if (!activeRecord) {
        return withCors(origin, Response.json({ valid: false, message: 'No tienes un check-in activo. Marca entrada primero.' }));
      }

      if (activeRecord.branch_id !== closest.branch.id) {
        return withCors(origin, Response.json({
          valid: false,
          message: `Debes hacer check-out en la misma sucursal donde iniciaste (${activeRecord.branch_id}). Actualmente estás en otra ubicación.`,
        }));
      }

      // Obtener hora actual y convertir al timezone de la sucursal
      const branchTimezone = closest.branch.timezone || 'America/Mexico_City';
      
      // Obtener hora actual en el timezone de la sucursal
      const nowInBranchTZ = dayjs().tz(branchTimezone);
      
      // Guardar la hora LOCAL de la sucursal con su timezone
      // PostgreSQL TIMESTAMPTZ necesita formato ISO con 'T': 'YYYY-MM-DDTHH:mm:ss+HH:mm'
      // Ejemplo: '2025-11-12T11:20:01-06:00'
      // PostgreSQL convertirá a UTC internamente pero preservará el timezone original
      const timeToSave = nowInBranchTZ.format('YYYY-MM-DDTHH:mm:ss') + nowInBranchTZ.format('Z');
      
      // LOGS PARA DEBUGGING
      console.log('=== CHECK-OUT DEBUG ===');
      console.log('Hora actual (servidor):', dayjs().format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('Timezone de sucursal:', branchTimezone);
      console.log('Hora en timezone de sucursal:', nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('Hora que se guardará (con timezone local):', timeToSave);
      console.log('======================');
      
      const { data: updated } = await supabase
        .from('attendance_records')
        .update({
          check_out_time: timeToSave,
          check_out_latitude: latitude,
          check_out_longitude: longitude,
          status: 'completed',
        })
        .eq('id', activeRecord.id)
        .select()
        .single();

      // LOGS POST-UPDATE
      console.log('=== POST-UPDATE CHECK-OUT ===');
      console.log('Registro actualizado:', updated);
      console.log('check_in_time desde BD (raw):', updated.check_in_time);
      console.log('check_out_time desde BD (raw):', updated.check_out_time);
      console.log('check_in_time parseado (UTC):', dayjs(updated.check_in_time).utc().format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('check_out_time parseado (UTC):', dayjs(updated.check_out_time).utc().format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('check_in_time en timezone de sucursal:', dayjs(updated.check_in_time).tz(branchTimezone).format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('check_out_time en timezone de sucursal:', dayjs(updated.check_out_time).tz(branchTimezone).format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('VERIFICACIÓN: La hora de check-out debería ser:', nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss Z'));
      console.log('¿Coinciden?:', dayjs(updated.check_out_time).tz(branchTimezone).format('YYYY-MM-DD HH:mm:ss') === nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss'));
      console.log('===================================');

      // Calcular horas trabajadas
      // Con TIMESTAMPTZ, los timestamps vienen en UTC desde PostgreSQL
      const checkInUTC = dayjs(updated.check_in_time);
      const checkOutUTC = dayjs(updated.check_out_time);
      const hoursWorked = checkOutUTC.diff(checkInUTC, 'hour', true);
      const totalMinutes = Math.floor(hoursWorked * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const timeWorkedFormatted = `${hours}h ${minutes}m`;

      // Formatear hora usando timezone de la sucursal
      // Con TIMESTAMPTZ, PostgreSQL devuelve el timestamp en UTC, pero podemos convertirlo al timezone de la sucursal
      const checkOutTime = dayjs(updated.check_out_time).tz(branchTimezone);
      const formattedTime = checkOutTime.format('hh:mm A');

      return withCors(origin, Response.json({
        valid: true,
        action: 'check_out',
        branch_name: closest.branch.name,
        time: updated.check_out_time,
        timezone: branchTimezone,
        hours_worked: hoursWorked.toFixed(2),
        time_worked_formatted: timeWorkedFormatted,
        message: `✅ Check-out registrado en ${closest.branch.name} a las ${formattedTime}. Tiempo trabajado: ${timeWorkedFormatted}.`,
      }));
    }

    return withCors(origin, Response.json({ valid: false, message: 'Acción no válida' }, { status: 400 }));
  } catch (error) {
    return handleApiError(error);
  }
}