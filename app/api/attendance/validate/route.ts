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

    const supabase = createServiceRoleClient();

    // 1) Find active employee by phone
    const { data: employee } = await supabase
      .from('employees')
      .select('id, status')
      .eq('phone', phone)
      .eq('status', 'active')
      .maybeSingle();

    if (!employee) {
      return withCors(origin, Response.json({ valid: false, message: 'Empleado no encontrado o inactivo' }));
    }

    // 2) Determinar automáticamente la acción si no se proporciona
    let action = providedAction;
    if (!action) {
      // Buscar registro activo del día de hoy
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

    // 3) Fetch active assigned branches
    const { data: employeeBranches } = await supabase
      .from('employee_branches')
      .select('branch_id, status')
      .eq('employee_id', employee.id);

    const activeBranchIds = (employeeBranches || [])
      .filter((eb: any) => eb.status === 'active')
      .map((eb: any) => eb.branch_id);

    if (activeBranchIds.length === 0) {
      return withCors(origin, Response.json({ valid: false, message: 'No tienes sucursales activas asignadas' }));
    }

    const { data: branches } = await supabase
      .from('branches')
      .select('id, name, latitude, longitude, tolerance_radius_meters, timezone, business_hours_start, tolerance_minutes')
      .in('id', activeBranchIds)
      .eq('status', 'active');

    const validBranches = (branches || []).filter((b: any) => {
      const distance = calculateDistance(latitude, longitude, Number(b.latitude), Number(b.longitude));
      return distance <= Number(b.tolerance_radius_meters);
    });

    if (!validBranches.length) {
      return withCors(origin, Response.json({
        valid: false,
        message: 'No estás en ninguna sucursal asignada. Asegúrate de estar dentro del radio permitido.',
      }));
    }

    const closest = validBranches.reduce(
      (acc: { branch: any; distance: number } | null, b: any) => {
        const d = calculateDistance(latitude, longitude, Number(b.latitude), Number(b.longitude));
        if (!acc || d < acc.distance) return { branch: b, distance: d };
        return acc;
      },
      null
    )!;

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
      let isLate = false;
      if (closest.branch.business_hours_start && closest.branch.tolerance_minutes !== null) {
        const [startHour, startMinute] = closest.branch.business_hours_start.split(':');
        const scheduledStart = nowInBranchTZ
          .clone()
          .hour(parseInt(startHour))
          .minute(parseInt(startMinute))
          .second(0)
          .millisecond(0);
        
        const toleranceMinutes = closest.branch.tolerance_minutes || 0;
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