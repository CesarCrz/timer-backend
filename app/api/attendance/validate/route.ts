import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError, UnauthorizedError } from '@/lib/utils/errors';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { calculateDistance } from '@/lib/geolocation/haversine';
import { limiter } from '@/lib/utils/rate-limit';

const bodySchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  action: z.enum(['check_in', 'check_out']),
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
    const { phone, latitude, longitude, action } = bodySchema.parse(body);

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

    // 2) Fetch active assigned branches
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
      .select('id, name, latitude, longitude, tolerance_radius_meters')
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

      const now = new Date().toISOString();
      const { data: record } = await supabase
        .from('attendance_records')
        .insert({
          employee_id: employee.id,
          branch_id: closest.branch.id,
          check_in_time: now,
          check_in_latitude: latitude,
          check_in_longitude: longitude,
          status: 'active',
        })
        .select()
        .single();

      return withCors(origin, Response.json({
        valid: true,
        action: 'check_in',
        branch_name: closest.branch.name,
        time: record.check_in_time,
        message: `✅ Check-in registrado en ${closest.branch.name} a las ${new Date(record.check_in_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`,
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

      const now = new Date().toISOString();
      const { data: updated } = await supabase
        .from('attendance_records')
        .update({
          check_out_time: now,
          check_out_latitude: latitude,
          check_out_longitude: longitude,
          status: 'completed',
        })
        .eq('id', activeRecord.id)
        .select()
        .single();

      const hoursWorked = (new Date(updated.check_out_time).getTime() - new Date(updated.check_in_time).getTime()) / (1000 * 60 * 60);

      return withCors(origin, Response.json({
        valid: true,
        action: 'check_out',
        branch_name: closest.branch.name,
        time: updated.check_out_time,
        hours_worked: hoursWorked.toFixed(2),
        message: `✅ Check-out registrado en ${closest.branch.name}. Trabajaste ${hoursWorked.toFixed(2)} horas.`,
      }));
    }

    return withCors(origin, Response.json({ valid: false, message: 'Acción no válida' }, { status: 400 }));
  } catch (error) {
    return handleApiError(error);
  }
}



