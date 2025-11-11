import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { calculateAttendanceMetrics } from '@/lib/reports/calculator';
import { sendEmail } from '@/lib/emails/client';
import { sendEmailWithAttachment } from '@/lib/emails/nodemailer-client';
import { renderTemplate } from '@/lib/emails/templates';

const schema = z.object({
  branch_ids: z.array(z.string().uuid()).optional(),
  employee_ids: z.array(z.string().uuid()).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['pdf', 'excel']).default('pdf'),
  email: z.string().email().optional(),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const body = await request.json();
    const params = schema.parse(body);

    const supabase = createServiceRoleClient();
    
    // Obtener moneda del negocio
    const businessId = await getUserBusinessId(user.id);
    const { data: business } = await supabase
      .from('businesses')
      .select('currency')
      .eq('id', businessId)
      .single();
    const currency = business?.currency || 'MXN';
    
    let query = supabase
      .from('attendance_records')
      .select('*, employee:employees(full_name, hourly_rate), branch:branches(name, business_hours_start, timezone)')
      .eq('status', 'completed');
    if (params.branch_ids && params.branch_ids.length) query = query.in('branch_id', params.branch_ids);
    if (params.employee_ids && params.employee_ids.length) query = query.in('employee_id', params.employee_ids);
    query = query.gte('check_in_time', `${params.start_date}T00:00:00.000Z`).lte('check_in_time', `${params.end_date}T23:59:59.999Z`);
    const { data: records } = await query.order('check_in_time', { ascending: true });
    
    if (!records || records.length === 0) {
      return withCors(origin, Response.json({ 
        error: 'No se encontraron registros de asistencia para el rango de fechas seleccionado' 
      }, { status: 404 }));
    }

    const byEmployee: Record<string, any> = {};
    (records || []).forEach((rec: any) => {
      const key = rec.employee_id;
      if (!byEmployee[key]) byEmployee[key] = { employee: rec.employee, records: [] };
      byEmployee[key].records.push(rec);
    });

    const reportData = Object.values(byEmployee).map((group: any) => {
      const daily = group.records.map((r: any) => calculateAttendanceMetrics(r));
      const totalHours = daily.reduce((s: number, d: any) => s + d.hours_worked, 0);
      const totalLateMinutes = daily.reduce((s: number, d: any) => s + d.late_minutes, 0);
      const totalOvertime = daily.reduce((s: number, d: any) => s + d.overtime_hours, 0);
      const totalPayment = daily.reduce((s: number, d: any) => s + d.total_payment, 0);
      return {
        employee_name: group.employee.full_name,
        hourly_rate: group.employee.hourly_rate,
        daily_breakdown: daily,
        summary: {
          total_days: daily.length,
          total_hours: Number(totalHours.toFixed(2)),
          total_late_minutes: Number(totalLateMinutes.toFixed(0)),
          total_overtime: Number(totalOvertime.toFixed(2)),
          total_payment: Number(totalPayment.toFixed(2)),
          late_days: daily.filter((d: any) => d.is_late).length,
        },
      };
    });

    let filename = `report-${Date.now()}.${params.format === 'pdf' ? 'pdf' : 'xlsx'}`;
    let attachmentContent: Buffer;
    let contentType: string;

    if (params.format === 'pdf') {
      const { generateReportHTML } = await import('@/lib/reports/pdf-generator');
      const html = generateReportHTML(reportData, params.start_date, params.end_date, currency);
      const puppeteer = await import('puppeteer');
      const browser = await puppeteer.launch({ 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: true,
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ 
        printBackground: true, 
        format: 'A4',
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      });
      await browser.close();
      attachmentContent = Buffer.from(pdf);
      contentType = 'application/pdf';
    } else {
      const { generateExcelReport } = await import('@/lib/reports/excel-generator');
      attachmentContent = await generateExcelReport(reportData, params.start_date, params.end_date);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    // Enviar al correo del usuario automáticamente
    const toEmails = [user.email as string];
    // Si se proporciona un email adicional, agregarlo
    if (params.email && params.email !== user.email) {
      toEmails.push(params.email);
    }
    
    const { subject, html } = renderTemplate('report-ready', {
      reportUrl: '#',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    
    // Usar Nodemailer para correos con adjuntos (reportes)
    try {
      await sendEmailWithAttachment({ 
        to: toEmails.join(','), 
        subject, 
        html, 
        attachments: [{ 
          filename, 
          content: attachmentContent, // Buffer - Nodemailer lo acepta directamente
          contentType,
        }] 
      });

      return withCors(origin, Response.json({ emailed: true }));
    } catch (emailError: any) {
      console.error('❌ [REPORTS] Error enviando correo con reporte:', {
        error: emailError.message,
        stack: emailError.stack,
        code: emailError.code,
        response: emailError.response,
        to: toEmails.join(','),
        filename,
        attachmentSize: attachmentContent.length,
      });
      
      // Re-lanzar el error para que handleApiError lo maneje
      throw emailError;
    }
  } catch (error) {
    return handleApiError(error);
  }
}











