import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { generateAttendanceReportHTML } from '@/lib/reports/attendance-report-generator';
import { calculateAttendanceMetrics } from '@/lib/reports/calculator';

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const businessId = await getUserBusinessId(user.id);
    const supabase = createServiceRoleClient();

    // Obtener el reporte del historial
    const { id } = await params;
    const { data: reportHistory, error: historyError } = await supabase
      .from('report_history')
      .select('*')
      .eq('id', id)
      .eq('business_id', businessId)
      .single();

    if (historyError || !reportHistory) {
      return withCors(
        origin,
        Response.json({ error: 'Reporte no encontrado' }, { status: 404 })
      );
    }

    // Obtener información del negocio
    const { data: business } = await supabase
      .from('businesses')
      .select('name, currency')
      .eq('id', businessId)
      .single();

    if (!business) {
      return withCors(
        origin,
        Response.json({ error: 'Negocio no encontrado' }, { status: 404 })
      );
    }

    // Construir query para obtener registros de asistencia
    let query = supabase
      .from('attendance_records')
      .select('*, employee:employees(full_name, hourly_rate, phone), branch:branches(name, business_hours_start, business_hours_end, timezone, address, tolerance_minutes)')
      .eq('status', 'completed')
      .not('check_out_time', 'is', null)
      .gte('check_in_time', `${reportHistory.start_date}T00:00:00.000Z`)
      .lte('check_in_time', `${reportHistory.end_date}T23:59:59.999Z`);

    // Filtrar por business_id a través de employees
    const { data: businessEmployees } = await supabase
      .from('employees')
      .select('id')
      .eq('business_id', businessId)
      .eq('status', 'active');

    const employeeIds = businessEmployees?.map(e => e.id) || [];
    if (employeeIds.length > 0) {
      query = query.in('employee_id', employeeIds);
    }

    // Aplicar filtros adicionales
    if (reportHistory.branch_ids && reportHistory.branch_ids.length > 0) {
      query = query.in('branch_id', reportHistory.branch_ids);
    }
    if (reportHistory.employee_ids && reportHistory.employee_ids.length > 0) {
      query = query.in('employee_id', reportHistory.employee_ids);
    }

    const { data: records, error: recordsError } = await query;

    if (recordsError) throw recordsError;

    if (!records || records.length === 0) {
      return withCors(
        origin,
        Response.json({ error: 'No se encontraron registros para este reporte' }, { status: 404 })
      );
    }

    // Agrupar por empleado
    const byEmployee: Record<string, any> = {};
    (records || []).forEach((rec: any) => {
      const key = rec.employee_id;
      if (!byEmployee[key]) byEmployee[key] = { employee: rec.employee, records: [] };
      byEmployee[key].records.push(rec);
    });

    // Determinar tipo de reporte
    let reportType: 'business' | 'branch' | 'personal' = reportHistory.report_type as any;
    let branchName: string | undefined;
    let branchLocation: string | undefined;
    let branchTimezone: string | undefined;
    let branchHoursStart: string | undefined;
    let branchHoursEnd: string | undefined;
    let employeeName: string | undefined;
    let employeeId: string | undefined;
    let employeePhone: string | undefined;

    if (reportHistory.employee_ids && reportHistory.employee_ids.length === 1) {
      const emp = Object.values(byEmployee)[0] as any;
      if (emp && emp.employee) {
        employeeName = emp.employee.full_name;
        employeeId = reportHistory.employee_ids[0];
        employeePhone = emp.employee.phone;
      }
    } else if (reportHistory.branch_ids && reportHistory.branch_ids.length === 1) {
      const firstRecord = records?.[0];
      if (firstRecord?.branch) {
        branchName = firstRecord.branch.name;
        branchLocation = firstRecord.branch.address || undefined;
        branchTimezone = firstRecord.branch.timezone || undefined;
        branchHoursStart = firstRecord.branch.business_hours_start || undefined;
        branchHoursEnd = firstRecord.branch.business_hours_end || undefined;
      }
    }

    // Generar reportData
    const reportData = Object.values(byEmployee)
      .filter((group: any) => group.employee) // Filtrar grupos sin employee
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
            total_overtime_hours: Number(totalOvertime.toFixed(2)),
            total_payment: Number(totalPayment.toFixed(2)),
          },
        };
      });

    // Generar HTML
    const html = generateAttendanceReportHTML({
      reportData,
      startDate: reportHistory.start_date,
      endDate: reportHistory.end_date,
      currency: business.currency || 'MXN',
      businessName: business.name,
      reportType,
      branchName,
      branchLocation,
      branchTimezone,
      branchHoursStart,
      branchHoursEnd,
      employeeName,
      employeeId,
      employeeEmail: undefined,
      employeePhone,
    });

    // Generar PDF o Excel según el formato original
    let fileBytes: Uint8Array;
    let contentType: string;
    let filename: string;

    if (reportHistory.format === 'pdf') {
      const puppeteer = await import('puppeteer');
      const fs = await import('fs');
      
      // Configurar executablePath para usar Chromium del sistema (Docker/Alpine)
      const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
      const launchOptions: any = {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
        ],
      };
      
      // Usar Chromium del sistema si existe
      if (fs.existsSync(chromiumPath)) {
        launchOptions.executablePath = chromiumPath;
        console.log('Usando Chromium del sistema en:', chromiumPath);
      } else {
        // Fallback al Chromium de Puppeteer
        try {
          const executablePath = puppeteer.executablePath();
          if (executablePath) {
            launchOptions.executablePath = executablePath;
            console.log('Usando Chromium de Puppeteer en:', executablePath);
          }
        } catch (e) {
          console.warn('No se pudo obtener executablePath, usando default');
        }
      }
      
      const browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ 
        printBackground: true, 
        format: 'A4',
        margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      });
      await browser.close();
      fileBytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf as any);
      contentType = 'application/pdf';
      filename = `reporte-${reportHistory.start_date}-${reportHistory.end_date}.pdf`;
    } else {
      const { generateExcelReport } = await import('@/lib/reports/excel-generator');
      const excelBuffer = await generateExcelReport(reportData, reportHistory.start_date, reportHistory.end_date);
      fileBytes = excelBuffer instanceof Uint8Array ? excelBuffer : new Uint8Array(excelBuffer);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      filename = `reporte-${reportHistory.start_date}-${reportHistory.end_date}.xlsx`;
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    
    const arrayBuffer = fileBytes.buffer instanceof ArrayBuffer 
      ? fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
      : new Uint8Array(fileBytes).buffer;
    const blob = new Blob([arrayBuffer], { type: contentType });
    const response = new Response(blob, { status: 200, headers });
    
    return withCors(origin, response);
  } catch (error) {
    return handleApiError(error);
  }
}

