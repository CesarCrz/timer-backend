import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/utils/auth';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  try {
    const { data: expired } = await supabase
      .from('employee_invitations')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .select();
    return Response.json({ success: true, expired: expired?.length || 0 });
  } catch (error: any) {
    return Response.json({ error: 'Failed to expire invitations' }, { status: 500 });
  }
}







