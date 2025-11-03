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

    await Promise.all(activeRecords.map((record: any) => {
      const checkInDate = new Date(record.check_in_time);
      const [h, m] = record.branch.business_hours_end.split(':');
      const auto = new Date(checkInDate);
      auto.setHours(parseInt(h), parseInt(m), 0, 0);
      return supabase
        .from('attendance_records')
        .update({ check_out_time: auto.toISOString(), status: 'completed', is_auto_closed: true })
        .eq('id', record.id);
    }));

    return Response.json({ success: true, closed: activeRecords.length });
  } catch (error: any) {
    return Response.json({ error: 'Failed to auto-close records' }, { status: 500 });
  }
}


