import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/utils/auth';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);

    const { data: activeRecords } = await supabase
      .from('attendance_records')
      .select('id, check_in_time, branch:branches(business_hours_end, timezone)')
      .eq('status', 'active')
      .lt('check_in_time', yesterday.toISOString());

    if (!activeRecords || activeRecords.length === 0) {
      return Response.json({ success: true, closed: 0 });
    }

    // Importar dayjs para manejo correcto de timezones
    const dayjs = (await import('dayjs')).default;
    const utc = (await import('dayjs/plugin/utc')).default;
    const timezone = (await import('dayjs/plugin/timezone')).default;
    dayjs.extend(utc);
    dayjs.extend(timezone);

    await Promise.all(activeRecords.map((record: any) => {
      // El check_in_time está guardado en UTC, necesitamos convertirlo al timezone de la sucursal
      // para calcular la hora de cierre correctamente
      const branchTimezone = record.branch?.timezone || 'America/Mexico_City';
      const checkInDate = dayjs.utc(record.check_in_time).tz(branchTimezone);
      const [h, m] = record.branch.business_hours_end.split(':');
      
      // Establecer la hora de cierre en el timezone de la sucursal
      const autoCheckOutInBranchTZ = checkInDate
        .hour(parseInt(h))
        .minute(parseInt(m))
        .second(0)
        .millisecond(0);
      
      // Convertir a UTC y usar formato SQL sin timezone para evitar problemas de interpretación
      // PostgreSQL 'timestamp without time zone' espera un string sin 'Z' o información de timezone
      const autoCheckOutUTC = autoCheckOutInBranchTZ.utc().format('YYYY-MM-DD HH:mm:ss');
      
      return supabase
        .from('attendance_records')
        .update({ check_out_time: autoCheckOutUTC, status: 'completed', is_auto_closed: true })
        .eq('id', record.id);
    }));

    return Response.json({ success: true, closed: activeRecords.length });
  } catch (error: any) {
    return Response.json({ error: 'Failed to auto-close records' }, { status: 500 });
  }
}







