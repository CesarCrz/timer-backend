import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { calculateAttendanceMetrics } from '@/lib/reports/calculator';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const schema = z.object({
  business_id: z.string().uuid().optional(),
  branch_ids: z.array(z.string().uuid()).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['pdf', 'excel']).default('pdf'),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const body = await request.json();
    const params = schema.parse(body);

    const supabase = createServiceRoleClient();

    // Obtener información del negocio (incluyendo timezone)
    const { data: business } = await supabase
      .from('businesses')
      .select('timezone')
      .eq('id', businessId)
      .single();
    const businessTimezone = business?.timezone || 'America/Mexico_City';
    
    // Convertir fechas del usuario (asumiendo que están en el timezone del negocio) a UTC
    const startDateInTZ = dayjs.tz(`${params.start_date} 00:00:00`, businessTimezone);
    const endDateInTZ = dayjs.tz(`${params.end_date} 23:59:59`, businessTimezone);
    
    // Convertir a UTC para la consulta inicial (rango amplio para capturar todos los registros posibles)
    const startDateTime = startDateInTZ.utc().subtract(1, 'day').startOf('day').toISOString();
    const endDateTime = endDateInTZ.utc().add(1, 'day').endOf('day').toISOString();

    // Fetch completed records for date range and optional branches
    // Incluir horarios de employee_branches para cada registro
    let query = supabase
      .from('attendance_records')
      .select('*, employee:employees(full_name, hourly_rate), branch:branches(name, business_hours_start, business_hours_end, timezone, address, tolerance_minutes)')
      .eq('status', 'completed');

    if (params.branch_ids && params.branch_ids.length) query = query.in('branch_id', params.branch_ids);
    query = query.gte('check_in_time', startDateTime).lte('check_in_time', endDateTime);

    const { data: records } = await query.order('check_in_time', { ascending: true });

    // Obtener horarios de employee_branches para cada registro
    const recordsWithHours = await Promise.all((records || []).map(async (rec: any) => {
      const { data: employeeBranch } = await supabase
        .from('employee_branches')
        .select('employees_hours_start, employees_hours_end, tolerance_minutes')
        .eq('employee_id', rec.employee_id)
        .eq('branch_id', rec.branch_id)
        .eq('status', 'active')
        .maybeSingle();
      
      return {
        ...rec,
        employee: {
          ...rec.employee,
          employees_hours_start: employeeBranch?.employees_hours_start || null,
          employees_hours_end: employeeBranch?.employees_hours_end || null,
          tolerance_minutes: employeeBranch?.tolerance_minutes || null,
        },
      };
    }));

    // Filtrar registros según el timezone de cada sucursal
    const filteredRecords = recordsWithHours.filter((rec: any) => {
      if (!rec.check_in_time) return false;
      
      const branchTZ = rec.branch?.timezone || businessTimezone;
      const checkInInBranchTZ = dayjs.utc(rec.check_in_time).tz(branchTZ);
      const checkInDate = checkInInBranchTZ.format('YYYY-MM-DD');
      
      // Log para depuración
      console.log('Filtering record:', {
        check_in_time_utc: rec.check_in_time,
        branch_timezone: branchTZ,
        check_in_date_in_tz: checkInDate,
        start_date: params.start_date,
        end_date: params.end_date,
        in_range: checkInDate >= params.start_date && checkInDate <= params.end_date
      });
      
      const isInRange = checkInDate >= params.start_date && checkInDate <= params.end_date;
      
      if (!isInRange) {
        console.log(`Record filtered out: ${checkInDate} is not between ${params.start_date} and ${params.end_date}`);
      }
      
      return isInRange;
    });
    
    console.log(`Filtered ${filteredRecords.length} records from ${recordsWithHours.length} total records`);

    const byEmployee: Record<string, any> = {};
    filteredRecords.forEach((rec: any) => {
      const key = rec.employee_id;
      if (!byEmployee[key]) byEmployee[key] = { employee: rec.employee, records: [] };
      byEmployee[key].records.push(rec);
    });

    const reportData = Object.values(byEmployee).map((group: any) => {
      const daily = group.records.map((r: any) => calculateAttendanceMetrics(r));
      const totalHours = daily.reduce((s: number, d: any) => s + d.hours_worked, 0);
      const totalLate = daily.reduce((s: number, d: any) => s + d.late_minutes, 0);
      const totalOvertime = daily.reduce((s: number, d: any) => s + d.overtime_hours, 0);
      const totalPayment = daily.reduce((s: number, d: any) => s + d.total_payment, 0);
      return {
        employee_name: group.employee?.full_name || 'N/A',
        hourly_rate: group.employee?.hourly_rate || 0,
        daily_breakdown: daily,
        summary: {
          total_days: daily.length,
          total_hours: Number(totalHours.toFixed(2)),
          total_late_minutes: Math.round(totalLate),
          total_overtime: Number(totalOvertime.toFixed(2)),
          total_payment: Number(totalPayment.toFixed(2)),
          late_days: daily.filter((d: any) => d.is_late).length,
        },
      };
    });

    let fileName = `report-${Date.now()}.${params.format === 'pdf' ? 'pdf' : 'xlsx'}`;
    let buffer: Buffer;

    if (params.format === 'pdf') {
      const html = `<html><body><pre>${escapeHtml(JSON.stringify(reportData, null, 2))}</pre></body></html>`;
      const puppeteer = await import('puppeteer');
      const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setContent(html);
      const pdf = await page.pdf({ printBackground: true, format: 'A4' });
      await browser.close();
      buffer = Buffer.from(pdf);
    } else {
      const ExcelJS = await import('exceljs');
      const wb = new (ExcelJS as any).Workbook();
      const ws = wb.addWorksheet('Report');
      ws.columns = [
        { header: 'Employee', key: 'employee', width: 30 },
        { header: 'Total Hours', key: 'hours', width: 15 },
        { header: 'Total Payment', key: 'payment', width: 15 },
      ];
      reportData.forEach((r: any) => ws.addRow({ employee: r.employee_name, hours: r.summary.total_hours, payment: r.summary.total_payment }));
      buffer = await wb.xlsx.writeBuffer();
    }

    const { data: uploadRes, error: uploadErr } = await supabase.storage.from('reports').upload(fileName, buffer, {
      contentType: params.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    });
    if (uploadErr) throw uploadErr;

    const expiresInSeconds = 60 * 60 * 24;
    const { data: signed } = await supabase.storage.from('reports').createSignedUrl(fileName, expiresInSeconds);
    const expires_at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    return withCors(origin, Response.json({ report_url: signed?.signedUrl || null, expires_at }));
  } catch (error) {
    return handleApiError(error);
  }
}

function escapeHtml(str: string) {
  return str.replace(/[&<>"]+/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}


