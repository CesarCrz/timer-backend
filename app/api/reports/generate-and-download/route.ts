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
    
    // Obtener información del negocio (incluyendo timezone)
    const businessId = await getUserBusinessId(user.id);
    const { data: business } = await supabase
      .from('businesses')
      .select('name, currency, timezone')
      .eq('id', businessId)
      .single();
    const currency = business?.currency || 'MXN';
    const businessTimezone = business?.timezone || 'America/Mexico_City';
    
    // Convertir fechas del usuario (asumiendo que están en el timezone del negocio) a UTC
    // El usuario selecciona fechas en su timezone local, necesitamos convertirlas a UTC para consultar la BD
    const startDateInTZ = dayjs.tz(`${params.start_date} 00:00:00`, businessTimezone);
    const endDateInTZ = dayjs.tz(`${params.end_date} 23:59:59`, businessTimezone);
    
    // Convertir a UTC para la consulta inicial (rango amplio para capturar todos los registros posibles)
    const startDateTime = startDateInTZ.utc().subtract(1, 'day').startOf('day').toISOString();
    const endDateTime = endDateInTZ.utc().add(1, 'day').endOf('day').toISOString();
    
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
    // Note: is_auto_closed is already included in the * selector
    // Horarios de employee_branches se obtendrán después
    
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
    // Verificar que el check_in_time convertido al timezone de la sucursal esté dentro del rango seleccionado
    const filteredRecords = recordsWithHours.filter((rec: any) => {
      if (!rec.check_in_time) return false;
      
      // Obtener timezone de la sucursal (o usar el del negocio como fallback)
      const branchTZ = rec.branch?.timezone || businessTimezone;
      
      // Convertir check_in_time (UTC en BD) al timezone de la sucursal
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
      
      // Verificar que la fecha esté dentro del rango seleccionado
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
      if (emp && emp.employee) {
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
          employee_email: undefined, // La tabla employees no tiene email
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
        businessTimezone, // Pasar timezone del negocio para mostrar fecha de generación correcta
      });
      const puppeteer = await import('puppeteer');
      
      // Configuración mejorada para Mac y otros sistemas
      const launchOptions: any = {
        headless: 'new', // Usar nuevo modo headless (más estable)
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
        timeout: 60000, // 60 segundos timeout
        protocolTimeout: 120000, // Timeout para protocolo (WebSocket)
      };

      // Configurar executablePath para usar Chromium del sistema (Docker/Alpine)
      const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
      try {
        // Verificar si existe el Chromium del sistema
        const fs = await import('fs');
        if (fs.existsSync(chromiumPath)) {
          launchOptions.executablePath = chromiumPath;
          console.log('Usando Chromium del sistema en:', chromiumPath);
        } else {
          // Intentar usar el Chromium de Puppeteer como fallback
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
      } catch (e) {
        console.warn('Error verificando Chromium, usando default:', e);
      }
      
      // Configuración adicional para Linux/Docker
      if (process.platform !== 'darwin') {
        launchOptions.args.push('--disable-background-timer-throttling');
        launchOptions.args.push('--disable-backgrounding-occluded-windows');
        launchOptions.args.push('--disable-renderer-backgrounding');
      }

      let browser;
      let page;
      try {
        console.log('Iniciando Puppeteer con opciones:', JSON.stringify(launchOptions, null, 2));
        browser = await puppeteer.launch(launchOptions);
        console.log('Puppeteer iniciado correctamente, URL:', browser.wsEndpoint());
        
        // Esperar un momento para que el navegador esté completamente listo
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        page = await browser.newPage();
        console.log('Página creada');
        
        // Configurar viewport y timeouts
        await page.setViewport({ width: 1200, height: 800 });
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(30000);
        
        console.log('Estableciendo contenido HTML...');
        await page.setContent(html, { 
          waitUntil: 'networkidle0',
          timeout: 30000 
        });
        console.log('Contenido HTML establecido');
        
        // Esperar un momento adicional para que todo se renderice
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log('Generando PDF...');
        const pdf = await page.pdf({ 
          printBackground: true, 
          format: 'A4',
          margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
          timeout: 30000,
        });
        console.log('PDF generado correctamente, tamaño:', pdf.length, 'bytes');
        
        fileBytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf as any);
        contentType = 'application/pdf';
      } catch (puppeteerError: any) {
        console.error('Error con Puppeteer:', puppeteerError);
        console.error('Error message:', puppeteerError.message);
        console.error('Error stack:', puppeteerError.stack);
        
        // Cerrar página y navegador de forma segura
        if (page) {
          try {
            await page.close();
          } catch (closeError) {
            console.error('Error cerrando página:', closeError);
          }
        }
        if (browser) {
          try {
            await browser.close();
          } catch (closeError) {
            console.error('Error cerrando navegador:', closeError);
          }
        }
        
        // Mensajes de error más específicos
        const errorMessage = puppeteerError.message || String(puppeteerError);
        if (errorMessage.includes('Timeout') || errorMessage.includes('WS endpoint') || errorMessage.includes('socket hang up') || errorMessage.includes('ECONNRESET')) {
          throw new Error(
            'Error al generar PDF: Puppeteer no pudo comunicarse con el navegador. ' +
            'Esto puede deberse a: 1) Chromium no está correctamente instalado, 2) Permisos insuficientes en Mac, ' +
            '3) El navegador se cerró inesperadamente. ' +
            'Solución: Ejecuta "cd backend && npm install puppeteer --force" para reinstalar Chromium.'
          );
        }
        throw puppeteerError;
      } finally {
        // Asegurar cierre en cualquier caso
        if (page) {
          try {
            await page.close();
          } catch (e) {
            console.error('Error en finally al cerrar página:', e);
          }
        }
        if (browser) {
          try {
            await browser.close();
            console.log('Navegador cerrado en finally');
          } catch (e) {
            console.error('Error en finally al cerrar navegador:', e);
          }
        }
      }
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



