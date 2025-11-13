import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/utils/auth';
import { calculateAttendanceMetrics } from '@/lib/reports/calculator';
import { sendEmailWithAttachment } from '@/lib/emails/nodemailer-client';
import { renderTemplate } from '@/lib/emails/templates';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  try {
    // Calcular rango de la semana actual (lunes a domingo)
    const now = dayjs();
    const startOfWeek = now.startOf('week').add(1, 'day'); // Lunes (dayjs usa domingo como inicio por defecto)
    const endOfWeek = startOfWeek.add(6, 'days'); // Domingo
    
    const startDate = startOfWeek.format('YYYY-MM-DD');
    const endDate = endOfWeek.format('YYYY-MM-DD');

    console.log(`📊 [WEEKLY REPORTS] Generando reportes semanales para la semana ${startDate} a ${endDate}`);

    // Obtener todos los negocios activos con sus dueños
    const { data: businesses, error: businessesError } = await supabase
      .from('businesses')
      .select('id, name, currency, owner_id, owner_name');

    if (businessesError) {
      console.error('❌ [WEEKLY REPORTS] Error obteniendo negocios:', businessesError);
      return Response.json({ error: 'Failed to fetch businesses' }, { status: 500 });
    }

    if (!businesses || businesses.length === 0) {
      console.log('ℹ️ [WEEKLY REPORTS] No hay negocios para generar reportes');
      return Response.json({ success: true, generated: 0, message: 'No businesses found' });
    }

    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    // Procesar cada negocio
    for (const business of businesses) {
      try {
        // Obtener email del dueño desde auth.users
        const { data: ownerData, error: ownerError } = await supabase.auth.admin.getUserById(business.owner_id);
        
        if (ownerError || !ownerData?.user?.email) {
          console.warn(`⚠️ [WEEKLY REPORTS] No se pudo obtener email del dueño para negocio ${business.name} (${business.id})`);
          errorCount++;
          errors.push(`Negocio ${business.name}: No se encontró email del dueño`);
          continue;
        }

        const ownerEmail = ownerData.user.email;

        // Obtener todos los empleados del negocio
        const { data: businessEmployees } = await supabase
          .from('employees')
          .select('id')
          .eq('business_id', business.id)
          .eq('status', 'active');

        if (!businessEmployees || businessEmployees.length === 0) {
          console.log(`ℹ️ [WEEKLY REPORTS] Negocio ${business.name} no tiene empleados activos, saltando...`);
          continue;
        }

        const employeeIds = businessEmployees.map(e => e.id);

        // Obtener registros de asistencia de la semana
        const startDateTime = `${startDate}T00:00:00.000Z`;
        const endDateTime = `${endDate}T23:59:59.999Z`;

        const { data: records, error: recordsError } = await supabase
          .from('attendance_records')
          .select('*, employee:employees(full_name, hourly_rate, phone), branch:branches(name, business_hours_start, business_hours_end, timezone, address, tolerance_minutes)')
          .eq('status', 'completed')
          .not('check_out_time', 'is', null)
          .in('employee_id', employeeIds)
          .gte('check_in_time', startDateTime)
          .lte('check_in_time', endDateTime)
          .order('check_in_time', { ascending: true });

        if (recordsError) {
          console.error(`❌ [WEEKLY REPORTS] Error obteniendo registros para ${business.name}:`, recordsError);
          errorCount++;
          errors.push(`Negocio ${business.name}: Error obteniendo registros`);
          continue;
        }

        if (!records || records.length === 0) {
          console.log(`ℹ️ [WEEKLY REPORTS] Negocio ${business.name} no tiene registros para la semana, saltando...`);
          continue;
        }

        // Agrupar por empleado
        const byEmployee: Record<string, any> = {};
        records.forEach((rec: any) => {
          const key = rec.employee_id;
          if (!byEmployee[key]) {
            byEmployee[key] = { employee: rec.employee, records: [] };
          }
          byEmployee[key].records.push(rec);
        });

        // Generar datos del reporte
        const reportData = Object.values(byEmployee)
          .filter((group: any) => group.employee)
          .map((group: any) => {
            const daily = group.records.map((r: any) => calculateAttendanceMetrics(r));
            const totalHours = daily.reduce((s: number, d: any) => s + d.hours_worked, 0);
            const totalLateMinutes = daily.reduce((s: number, d: any) => s + d.late_minutes, 0);
            const totalOvertime = daily.reduce((s: number, d: any) => s + d.overtime_hours, 0);
            const totalPayment = daily.reduce((s: number, d: any) => s + d.total_payment, 0);
            return {
              employee_name: group.employee?.full_name || 'N/A',
              employee_id: group.records[0]?.employee_id,
              employee_email: undefined,
              employee_phone: group.employee?.phone || undefined,
              hourly_rate: group.employee?.hourly_rate || 0,
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

        if (reportData.length === 0) {
          console.log(`ℹ️ [WEEKLY REPORTS] Negocio ${business.name} no tiene datos válidos para el reporte, saltando...`);
          continue;
        }

        // Generar reporte PDF
        const { generateAttendanceReportHTML } = await import('@/lib/reports/attendance-report-generator');
        const html = generateAttendanceReportHTML({
          reportData,
          startDate,
          endDate,
          currency: business.currency || 'MXN',
          businessName: business.name,
          reportType: 'business',
        });

        // Generar PDF usando Puppeteer
        const puppeteer = await import('puppeteer');
        const launchOptions: any = {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-default-apps',
          ],
          timeout: 60000,
          protocolTimeout: 120000,
        };

        const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
        try {
          const fs = await import('fs');
          if (fs.existsSync(chromiumPath)) {
            launchOptions.executablePath = chromiumPath;
          }
        } catch (e) {
          console.warn('No se pudo verificar Chromium, usando default');
        }

        if (process.platform !== 'darwin') {
          launchOptions.args.push('--disable-background-timer-throttling');
          launchOptions.args.push('--disable-backgrounding-occluded-windows');
          launchOptions.args.push('--disable-renderer-backgrounding');
        }

        const browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 800 });
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(30000);
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const pdf = await page.pdf({
          printBackground: true,
          format: 'A4',
          margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
          timeout: 30000,
        });
        
        await browser.close();

        const pdfBuffer = Buffer.from(pdf);

        // Preparar email
        const { subject, html: emailHtml } = renderTemplate('report-ready', {
          reportUrl: '#',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });

        const filename = `reporte-semanal-${business.name.replace(/\s+/g, '-').toLowerCase()}-${startDate}-${endDate}.pdf`;

        // Enviar email con adjunto
        await sendEmailWithAttachment({
          to: ownerEmail,
          subject: `📊 Reporte Semanal de Asistencia - ${business.name}`,
          html: emailHtml,
          attachments: [
            {
              filename,
              content: pdfBuffer,
              contentType: 'application/pdf',
            },
          ],
        });

        console.log(`✅ [WEEKLY REPORTS] Reporte enviado exitosamente a ${ownerEmail} para negocio ${business.name}`);
        successCount++;

      } catch (error: any) {
        console.error(`❌ [WEEKLY REPORTS] Error procesando negocio ${business.name}:`, error);
        errorCount++;
        errors.push(`Negocio ${business.name}: ${error.message || 'Error desconocido'}`);
      }
    }

    return Response.json({
      success: true,
      generated: successCount,
      errors: errorCount,
      errorDetails: errors.length > 0 ? errors : undefined,
      week: { startDate, endDate },
    });

  } catch (error: any) {
    console.error('❌ [WEEKLY REPORTS] Error general:', error);
    return Response.json({ error: 'Failed to generate weekly reports' }, { status: 500 });
  }
}

