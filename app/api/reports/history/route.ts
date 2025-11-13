import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '8');

    const supabase = createServiceRoleClient();
    
    const { data: history, error } = await supabase
      .from('report_history')
      .select('*')
      .eq('business_id', businessId)
      .order('generated_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Formatear datos para el frontend
    const formattedHistory = (history || []).map((report) => {
      let description = '';
      if (report.report_type === 'business') {
        description = 'Todas las sucursales';
      } else if (report.report_type === 'branch' && report.branch_names && report.branch_names.length > 0) {
        description = report.branch_names.length === 1 
          ? report.branch_names[0] 
          : `${report.branch_names.length} sucursales`;
      } else if (report.report_type === 'personal' && report.employee_names && report.employee_names.length > 0) {
        description = report.employee_names[0];
      }

      return {
        id: report.id,
        report_type: report.report_type,
        start_date: report.start_date,
        end_date: report.end_date,
        description,
        format: report.format,
        generated_at: report.generated_at,
      };
    });

    return withCors(origin, Response.json({ history: formattedHistory }));
  } catch (error) {
    return handleApiError(error);
  }
}

