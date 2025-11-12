import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { createServiceRoleClient, getCurrentUser, getUserBusinessId } from '@/lib/utils/auth';
import { calculateAttendanceMetrics } from '@/lib/reports/calculator';

const schema = z.object({
  branch_ids: z.array(z.string().uuid()).optional(),
  employee_ids: z.array(z.string().uuid()).optional(),
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
    const body = await request.json();
    const params = schema.parse(body);

    const supabase = createServiceRoleClient();
    
    // Obtener información del negocio
    const businessId = await getUserBusinessId(user.id);
    const { data: business } = await supabase
      .from('businesses')
      .select('name, currency')
      .eq('id', businessId)
      .single();
    const currency = business?.currency || 'MXN';
    
    // Construir fechas de inicio y fin del día en UTC
    // Usar formato ISO para asegurar compatibilidad con Supabase
    const startDateTime = `${params.start_date}T00:00:00.000Z`;
    const endDateTime = `${params.end_date}T23:59:59.999Z`;
    
    console.log('Query params:', {
      start_date: params.start_date,
      end_date: params.end_date,
      startDateTime,
      endDateTime,
      branch_ids: params.branch_ids,
      employee_ids: params.employee_ids,
      businessId,
    });
    
    let query = supabase
      .from('attendance_records')
      .select('*, employee:employees(full_name, hourly_rate, phone), branch:branches(name, business_hours_start, business_hours_end, timezone, address, tolerance_minutes)')
      .eq('status', 'completed')
      .not('check_out_time', 'is', null);
    
    // Filtrar por business_id a través de employees
    const { data: businessEmployees } = await supabase
      .from('employees')
      .select('id')
      .eq('business_id', businessId);
    
    const employeeIds = businessEmployees?.map(e => e.id) || [];
    if (employeeIds.length === 0) {
      return withCors(origin, Response.json({ 
        error: 'No se encontraron empleados para este negocio' 
      }, { status: 404 }));
    }
    
    query = query.in('employee_id', employeeIds);
    
    if (params.branch_ids && params.branch_ids.length) query = query.in('branch_id', params.branch_ids);
    if (params.employee_ids && params.employee_ids.length) {
      // Filtrar solo los employee_ids que pertenecen al negocio
      const validEmployeeIds = params.employee_ids.filter(id => employeeIds.includes(id));
      if (validEmployeeIds.length > 0) {
        query = query.in('employee_id', validEmployeeIds);
      } else {
        return withCors(origin, Response.json({ 
          error: 'Los empleados seleccionados no pertenecen a este negocio' 
        }, { status: 400 }));
      }
    }
    
    query = query.gte('check_in_time', startDateTime).lte('check_in_time', endDateTime);
    const { data: records, error: queryError } = await query.order('check_in_time', { ascending: true });
    
    if (queryError) {
      console.error('Error querying attendance records:', queryError);
      return withCors(origin, Response.json({ 
        error: 'Error al consultar registros de asistencia',
        details: queryError.message 
      }, { status: 500 }));
    }
    
    console.log(`Found ${records?.length || 0} records for date range ${params.start_date} to ${params.end_date}`);
    
    if (!records || records.length === 0) {
      return withCors(origin, Response.json({ 
        error: `No se encontraron registros de asistencia para el rango de fechas seleccionado (${params.start_date} a ${params.end_date})` 
      }, { status: 404 }));
    }

    const byEmployee: Record<string, any> = {};
    (records || []).forEach((rec: any) => {
      const key = rec.employee_id;
      if (!byEmployee[key]) byEmployee[key] = { employee: rec.employee, records: [] };
      byEmployee[key].records.push(rec);
    });

    // Determinar tipo de reporte
    let reportType: 'business' | 'branch' | 'personal' = 'business';
    let branchName: string | undefined;
    let branchLocation: string | undefined;
    let branchTimezone: string | undefined;
    let branchHoursStart: string | undefined;
    let branchHoursEnd: string | undefined;
    let employeeName: string | undefined;
    let employeeId: string | undefined;
    let employeeEmail: string | undefined;
    let employeePhone: string | undefined;
    
    if (params.employee_ids && params.employee_ids.length === 1) {
      reportType = 'personal';
      const emp = Object.values(byEmployee)[0] as any;
      if (emp) {
        employeeName = emp.employee.full_name;
        employeeId = params.employee_ids[0];
        employeeEmail = undefined; // La tabla employees no tiene email
        employeePhone = emp.employee.phone;
      }
    } else if (params.branch_ids && params.branch_ids.length === 1) {
      reportType = 'branch';
      const firstRecord = records?.[0];
      if (firstRecord?.branch) {
        branchName = firstRecord.branch.name;
        branchLocation = firstRecord.branch.address;
        branchTimezone = firstRecord.branch.timezone;
        branchHoursStart = firstRecord.branch.business_hours_start;
        branchHoursEnd = firstRecord.branch.business_hours_end;
      }
    }
    
    const reportData = Object.values(byEmployee).map((group: any) => {
      const daily = group.records.map((r: any) => calculateAttendanceMetrics(r));
      const totalHours = daily.reduce((s: number, d: any) => s + d.hours_worked, 0);
      const totalLateMinutes = daily.reduce((s: number, d: any) => s + d.late_minutes, 0);
      const totalOvertime = daily.reduce((s: number, d: any) => s + d.overtime_hours, 0);
      const totalPayment = daily.reduce((s: number, d: any) => s + d.total_payment, 0);
      return {
        employee_name: group.employee.full_name,
        employee_id: group.records[0]?.employee_id,
        employee_email: undefined, // La tabla employees no tiene email
        employee_phone: group.employee.phone,
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
    let fileBytes: Uint8Array;
    let contentType: string;

    if (params.format === 'pdf') {
      const { generateAttendanceReportHTML } = await import('@/lib/reports/attendance-report-generator');
      const html = generateAttendanceReportHTML({
        reportData,
        startDate: params.start_date,
        endDate: params.end_date,
        currency,
        businessName: business?.name || 'Negocio',
        reportType,
        branchName,
        branchLocation,
        branchTimezone,
        branchHoursStart,
        branchHoursEnd,
        employeeName,
        employeeId,
        employeeEmail,
        employeePhone,
      });
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
      fileBytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf as any);
      contentType = 'application/pdf';
    } else {
      const { generateExcelReport } = await import('@/lib/reports/excel-generator');
      const excelBuffer = await generateExcelReport(reportData, params.start_date, params.end_date);
      fileBytes = excelBuffer instanceof Uint8Array ? excelBuffer : new Uint8Array(excelBuffer);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    // Guardar en historial de reportes
    try {
      const branchNames = params.branch_ids && params.branch_ids.length > 0
        ? (await Promise.all(
            params.branch_ids.map(async (id) => {
              const { data } = await supabase.from('branches').select('name').eq('id', id).single();
              return data?.name || '';
            })
          )).filter(Boolean)
        : [];
      
      const employeeNames = params.employee_ids && params.employee_ids.length > 0
        ? (await Promise.all(
            params.employee_ids.map(async (id) => {
              const { data } = await supabase.from('employees').select('full_name').eq('id', id).single();
              return data?.full_name || '';
            })
          )).filter(Boolean)
        : [];

      await supabase.from('report_history').insert({
        business_id: businessId,
        report_type: reportType,
        start_date: params.start_date,
        end_date: params.end_date,
        branch_ids: params.branch_ids || null,
        branch_names: branchNames.length > 0 ? branchNames : null,
        employee_ids: params.employee_ids || null,
        employee_names: employeeNames.length > 0 ? employeeNames : null,
        format: params.format,
        created_by: user.id,
      });
    } catch (historyError) {
      // No fallar si no se puede guardar el historial
      console.error('Error guardando historial de reporte:', historyError);
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    
    const arrayBuffer = fileBytes.buffer instanceof ArrayBuffer 
      ? fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
      : new Uint8Array(fileBytes).buffer;
    const blob = new Blob([arrayBuffer], { type: contentType });
    const response = new Response(blob, { status: 200, headers });
    
    // Aplicar CORS usando withCors
    return withCors(origin, response);
  } catch (error) {
    return handleApiError(error);
  }
}



