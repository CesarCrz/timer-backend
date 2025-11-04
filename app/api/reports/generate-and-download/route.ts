import { z } from 'zod';
import { preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser } from '@/lib/utils/auth';
import { calculateAttendanceMetrics } from '@/lib/reports/calculator';

const schema = z.object({
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
    await getCurrentUser(request);
    const body = await request.json();
    const params = schema.parse(body);

    const supabase = createServiceRoleClient();
    let query = supabase
      .from('attendance_records')
      .select('*, employee:employees(full_name, hourly_rate), branch:branches(name, business_hours_start, timezone)')
      .eq('status', 'completed');
    if (params.branch_ids && params.branch_ids.length) query = query.in('branch_id', params.branch_ids);
    query = query.gte('check_in_time', `${params.start_date}T00:00:00.000Z`).lte('check_in_time', `${params.end_date}T23:59:59.999Z`);
    const { data: records } = await query.order('check_in_time', { ascending: true });

    const byEmployee: Record<string, any> = {};
    (records || []).forEach((rec: any) => {
      const key = rec.employee_id;
      if (!byEmployee[key]) byEmployee[key] = { employee: rec.employee, records: [] };
      byEmployee[key].records.push(rec);
    });

    const reportData = Object.values(byEmployee).map((group: any) => {
      const daily = group.records.map((r: any) => calculateAttendanceMetrics(r));
      const totalHours = daily.reduce((s: number, d: any) => s + d.hours_worked, 0);
      const totalPayment = daily.reduce((s: number, d: any) => s + d.total_payment, 0);
      return {
        employee_name: group.employee.full_name,
        hourly_rate: group.employee.hourly_rate,
        daily_breakdown: daily,
        summary: {
          total_days: daily.length,
          total_hours: Number(totalHours.toFixed(2)),
          total_payment: Number(totalPayment.toFixed(2)),
        },
      };
    });

    let filename = `report-${Date.now()}.${params.format === 'pdf' ? 'pdf' : 'xlsx'}`;
    let fileBytes: Uint8Array;
    let contentType: string;

    if (params.format === 'pdf') {
      const html = `<html><body><pre>${escapeHtml(JSON.stringify(reportData, null, 2))}</pre></body></html>`;
      const puppeteer = await import('puppeteer');
      const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setContent(html);
      const pdf = await page.pdf({ printBackground: true, format: 'A4' });
      await browser.close();
      fileBytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf as any);
      contentType = 'application/pdf';
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
      const excelBuffer = await wb.xlsx.writeBuffer();
      fileBytes = excelBuffer instanceof Uint8Array ? excelBuffer : new Uint8Array(excelBuffer as any);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    const arrayBuffer = fileBytes.buffer instanceof ArrayBuffer 
      ? fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
      : new Uint8Array(fileBytes).buffer;
    const blob = new Blob([arrayBuffer], { type: contentType });
    return new Response(blob, { status: 200, headers });
  } catch (error) {
    return handleApiError(error);
  }
}

function escapeHtml(str: string) {
  return str.replace(/[&<>"]+/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}


