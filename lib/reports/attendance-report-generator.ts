import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { calculateAttendanceMetrics, AttendanceRecord } from './calculator';

dayjs.extend(utc);
dayjs.extend(timezone);

type ReportType = 'business' | 'branch' | 'personal';

type ReportParams = {
  reportData: any[];
  startDate: string;
  endDate: string;
  currency: string;
  businessName: string;
  reportType: ReportType;
  branchName?: string;
  branchLocation?: string;
  branchTimezone?: string;
  branchHoursStart?: string;
  branchHoursEnd?: string;
  employeeName?: string;
  employeeId?: string;
  employeeEmail?: string;
  employeePhone?: string;
};

export function generateAttendanceReportHTML(params: ReportParams): string {
  const {
    reportData,
    startDate,
    endDate,
    currency,
    businessName,
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
  } = params;

  if (!reportData || reportData.length === 0) {
    return generateEmptyReportHTML(businessName, startDate, endDate);
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency }).format(amount);
  };

  const formatDate = (dateStr: string) => {
    const date = dayjs(dateStr);
    return date.format('DD [de] MMMM [de] YYYY');
  };

  const formatTimeWorked = (hours: number) => {
    const totalMinutes = Math.floor(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}h ${m}m`;
  };

  const generatedDate = dayjs().format('DD [de] MMMM [de] YYYY, hh:mm A');

  let reportContent = '';

  if (reportType === 'business') {
    // Agrupar por sucursal y obtener información de cada sucursal
    const byBranch: Record<string, any> = {};
    const branchInfo: Record<string, { hoursStart?: string; hoursEnd?: string; location?: string; timezone?: string }> = {};
    
    // Primero, obtener información de sucursales desde los registros
    reportData.forEach((emp) => {
      emp.daily_breakdown.forEach((day: any) => {
        const branchKey = day.branch_name || 'Sin sucursal';
        if (!branchInfo[branchKey] && day.branch_hours_start) {
          branchInfo[branchKey] = {
            hoursStart: day.branch_hours_start,
            hoursEnd: day.branch_hours_end,
            location: day.branch_location,
            timezone: day.branch_timezone,
          };
        }
      });
    });
    
    reportData.forEach((emp) => {
      emp.daily_breakdown.forEach((day: any) => {
        const branchKey = day.branch_name || 'Sin sucursal';
        if (!byBranch[branchKey]) {
          byBranch[branchKey] = {
            name: branchKey,
            location: branchInfo[branchKey]?.location || '',
            timezone: branchInfo[branchKey]?.timezone || '',
            hoursStart: branchInfo[branchKey]?.hoursStart,
            hoursEnd: branchInfo[branchKey]?.hoursEnd,
            employees: [],
            totalEmployees: 0,
            totalWorkedHours: 0,
            totalCost: 0,
          };
        }
        
        // Agrupar empleados por sucursal
        let empInBranch = byBranch[branchKey].employees.find((e: any) => e.name === emp.employee_name);
        if (!empInBranch) {
          empInBranch = {
            name: emp.employee_name,
            id: emp.employee_id || '',
            email: emp.employee_email || '',
            phone: emp.employee_phone || '',
            dailyRecords: [],
            workedHours: 0,
            overtimeHours: 0,
            absenceHours: 0,
            attendanceRate: 0,
            calculatedSalary: 0,
          };
          byBranch[branchKey].employees.push(empInBranch);
        }
        
        // Agregar registro diario
        empInBranch.dailyRecords.push({
          date: day.date,
          entryTime: day.check_in,
          exitTime: day.check_out || '-',
          branchName: day.branch_name || 'Sin sucursal',
          workedHours: formatTimeWorked(day.hours_worked),
          overtimeHours: day.overtime_hours > 0 ? `${day.overtime_hours}h` : '-',
          baseSalaryDay: formatCurrency(day.base_payment),
          salaryWithLate: formatCurrency(day.payment_with_late),
          totalSalaryDay: formatCurrency(day.total_payment),
          isLate: day.is_late,
          lateDeduction: day.late_minutes > 0 ? formatCurrency(day.base_payment - day.payment_with_late) : '-',
        });
        
        empInBranch.workedHours += day.hours_worked;
        empInBranch.overtimeHours += day.overtime_hours;
        empInBranch.calculatedSalary += day.total_payment;
      });
    });

    // Calcular totales por sucursal
    Object.values(byBranch).forEach((branch: any) => {
      branch.totalEmployees = branch.employees.length;
      // Calcular total de horas trabajadas como número primero
      const totalHoursNumber = branch.employees.reduce((sum: number, e: any) => sum + e.workedHours, 0);
      branch.totalCost = branch.employees.reduce((sum: number, e: any) => sum + e.calculatedSalary, 0);
      
      branch.employees.forEach((emp: any) => {
        emp.workedHours = formatTimeWorked(emp.workedHours);
        emp.overtimeHours = formatTimeWorked(emp.overtimeHours);
        emp.calculatedSalary = formatCurrency(emp.calculatedSalary);
        emp.attendanceRate = 100; // Calcular si es necesario
      });
      
      // Formatear el total de horas trabajadas después de formatear las individuales
      branch.totalWorkedHours = formatTimeWorked(totalHoursNumber);
    });

    // Generar HTML para cada sucursal
    Object.values(byBranch).forEach((branch: any) => {
      reportContent += generateBranchSectionHTML(branch, formatCurrency, formatTimeWorked, businessName, branch.hoursStart, branch.hoursEnd);
    });
  } else if (reportType === 'branch') {
    // Reporte de una sucursal específica
    const branchData = {
      name: branchName || 'Sucursal',
      location: branchLocation || '',
      timezone: branchTimezone || '',
      employees: reportData.map((emp) => ({
        name: emp.employee_name,
        id: emp.employee_id || '',
        email: emp.employee_email || '',
        phone: emp.employee_phone || '',
        dailyRecords: emp.daily_breakdown.map((day: any) => ({
          date: day.date,
          entryTime: day.check_in,
          exitTime: day.check_out || '-',
          branchName: day.branch_name || 'Sin sucursal',
          workedHours: formatTimeWorked(day.hours_worked),
          overtimeHours: day.overtime_hours > 0 ? `${day.overtime_hours}h` : '-',
          baseSalaryDay: formatCurrency(day.base_payment),
          salaryWithLate: formatCurrency(day.payment_with_late),
          totalSalaryDay: formatCurrency(day.total_payment),
          isLate: day.is_late,
          lateDeduction: day.late_minutes > 0 ? formatCurrency(day.base_payment - day.payment_with_late) : '-',
        })),
        workedHours: typeof emp.summary.total_hours === 'number' ? formatTimeWorked(emp.summary.total_hours) : emp.summary.total_hours,
        overtimeHours: typeof emp.summary.total_overtime === 'number' ? formatTimeWorked(emp.summary.total_overtime) : emp.summary.total_overtime,
        absenceHours: '0h',
        attendanceRate: 100,
        calculatedSalary: formatCurrency(emp.summary.total_payment),
      })),
      totalEmployees: reportData.length,
      totalWorkedHours: formatTimeWorked(reportData.reduce((sum, emp) => sum + (typeof emp.summary.total_hours === 'number' ? emp.summary.total_hours : 0), 0)),
      totalCost: formatCurrency(reportData.reduce((sum, emp) => sum + emp.summary.total_payment, 0)),
    };

    reportContent = generateBranchSectionHTML(branchData, formatCurrency, formatTimeWorked, businessName, branchHoursStart, branchHoursEnd);
  } else if (reportType === 'personal') {
    // Reporte personal de un empleado
    const emp = reportData[0];
    reportContent = generatePersonalSectionHTML(
      {
        name: employeeName || emp.employee_name,
        id: employeeId || '',
        email: employeeEmail || '',
        phone: employeePhone || '',
        baseSalary: formatCurrency(emp.hourly_rate * 8 * 30), // Estimado mensual
        dailyRecords: emp.daily_breakdown.map((day: any) => ({
          date: day.date,
          entryTime: day.check_in,
          exitTime: day.check_out || '-',
          branchName: day.branch_name || 'Sin sucursal',
          workedHours: formatTimeWorked(day.hours_worked),
          notWorkedHours: '0h',
          overtimeHours: day.overtime_hours > 0 ? `${day.overtime_hours}h` : '-',
          baseSalaryDay: formatCurrency(day.base_payment),
          lateDeduction: day.late_minutes > 0 ? formatCurrency(day.base_payment - day.payment_with_late) : '-',
          overtimeCompensation: formatCurrency(day.overtime_payment),
          totalSalaryDay: formatCurrency(day.total_payment),
          isLate: day.is_late,
        })),
        totalWorkedHours: typeof emp.summary.total_hours === 'number' ? formatTimeWorked(emp.summary.total_hours) : emp.summary.total_hours,
        calculatedSalary: formatCurrency(emp.summary.total_payment),
      },
      formatCurrency,
      branchHoursStart || '08:00',
      formatTimeWorked
    );
  }

  // Determinar información para firmas según tipo de reporte
  let signatureInfo: {
    signer1: string;
    signer2: string;
  };
  
  if (reportType === 'business') {
    signatureInfo = {
      signer1: 'Encargado de Recursos Humanos',
      signer2: `Encargado de ${businessName}`,
    };
  } else if (reportType === 'branch') {
    signatureInfo = {
      signer1: 'Encargado de Recursos Humanos',
      signer2: `Encargado de ${businessName}`,
    };
  } else {
    // Personal
    signatureInfo = {
      signer1: 'Encargado de Recursos Humanos',
      signer2: employeeName || 'Empleado',
    };
  }

  return generateFullReportHTML({
    businessName,
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    generatedDate,
    reportType: reportType === 'business' ? 'Negocio Completo' : reportType === 'branch' ? 'Sucursal' : 'Personal',
    content: reportContent,
    signatureInfo,
  });
}

function generateBranchSectionHTML(
  branch: any,
  formatCurrency: (n: number) => string,
  formatTimeWorked: (h: number) => string,
  businessName: string,
  hoursStart?: string,
  hoursEnd?: string
): string {
  // Formatear horas de la sucursal (pueden venir como HH:MM:SS o HH:MM)
  const formatBranchHours = (time: string | undefined) => {
    if (!time) return '';
    const parts = time.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : time;
  };
  const formattedStart = formatBranchHours(hoursStart);
  const formattedEnd = formatBranchHours(hoursEnd);
  const hoursInfo = formattedStart && formattedEnd ? `🕐 Horario: ${formattedStart} - ${formattedEnd}` : '';
  
  let employeesHTML = '';
  branch.employees.forEach((emp: any) => {
    let dailyRows = '';
    emp.dailyRecords.forEach((record: any) => {
      const entryClass = record.entryTime === '-' ? 'cell-absent' : record.isLate ? 'cell-warning' : 'cell-success';
      dailyRows += `
        <tr>
          <td class="cell-date">${record.date}</td>
          <td>${record.branchName || 'Sin sucursal'}</td>
          <td class="${entryClass}">${record.entryTime}</td>
          <td class="${record.exitTime === '-' ? 'cell-absent' : ''}">${record.exitTime}</td>
          <td>${record.workedHours}</td>
          <td class="${record.overtimeHours !== '-' ? 'cell-success' : ''}">${record.overtimeHours}</td>
          <td>${record.baseSalaryDay}</td>
          <td class="${record.lateDeduction !== '-' ? 'cell-error' : 'cell-success'}">${record.salaryWithLate}</td>
          <td class="cell-success" style="font-weight: 700;">${record.totalSalaryDay}</td>
        </tr>
      `;
    });

    employeesHTML += `
      <div class="employee-section">
        <div class="employee-header">
          <div>
            <div class="employee-name">${emp.name}</div>
            <div class="employee-meta">ID: ${emp.id} | 📧 ${emp.email} | 📱 ${emp.phone}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 14px; font-weight: 700; color: #10b981;">
              ${emp.calculatedSalary}
            </div>
            <div style="font-size: 12px; color: #6b7280;">Sueldo Total</div>
          </div>
        </div>

        <div class="employee-stats">
          <div class="stat-mini">
            <div class="stat-mini-label">Horas Trabajadas</div>
            <div class="stat-mini-value">${emp.workedHours}</div>
          </div>
          <div class="stat-mini">
            <div class="stat-mini-label">Tiempo Extra</div>
            <div class="stat-mini-value">${emp.overtimeHours}</div>
          </div>
          <div class="stat-mini">
            <div class="stat-mini-label">Inasistencias</div>
            <div class="stat-mini-value">${emp.absenceHours}</div>
          </div>
          <div class="stat-mini">
            <div class="stat-mini-label">Asistencia %</div>
            <div class="stat-mini-value">${emp.attendanceRate}%</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Día</th>
              <th>Sucursal</th>
              <th>Entrada</th>
              <th>Salida</th>
              <th>Horas Trabajadas</th>
              <th>Tiempo Extra</th>
              <th>Sueldo Base Día</th>
              <th>Sueldo con Tardanza</th>
              <th>Sueldo Total</th>
            </tr>
          </thead>
          <tbody>
            ${dailyRows}
          </tbody>
        </table>
      </div>
    `;
  });

  return `
    <div class="page-break">
      <h2 class="section-title">Sucursal: ${branch.name}</h2>
      ${branch.location ? `<p style="color: #6b7280; margin-bottom: 15px; font-size: 14px;">📍 ${branch.location} | ${branch.timezone ? `🕐 ${branch.timezone}` : ''} ${hoursInfo ? `| ${hoursInfo}` : ''}</p>` : ''}

      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-label">Total Empleados</div>
          <div class="summary-value">${branch.totalEmployees}</div>
        </div>
        <div class="summary-card success">
          <div class="summary-label">Total Horas Trabajadas</div>
          <div class="summary-value">${branch.totalWorkedHours}</div>
        </div>
        <div class="summary-card warning">
          <div class="summary-label">Total Costo Nómina</div>
          <div class="summary-value">${branch.totalCost}</div>
        </div>
      </div>

      ${employeesHTML}
    </div>
  `;
}

function generatePersonalSectionHTML(
  employee: any,
  formatCurrency: (n: number) => string,
  lateStartHour: string,
  formatTimeWorked: (h: number) => string
): string {
  let dailyRows = '';
  employee.dailyRecords.forEach((record: any) => {
    const entryClass = record.entryTime === '-' ? 'cell-absent' : record.isLate ? 'cell-warning' : 'cell-success';
    dailyRows += `
      <tr>
        <td class="cell-date">${record.date}</td>
        <td>${record.branchName || 'Sin sucursal'}</td>
        <td class="${entryClass}">${record.entryTime}</td>
        <td class="${record.exitTime === '-' ? 'cell-absent' : ''}">${record.exitTime}</td>
        <td>${record.workedHours}</td>
        <td>${record.notWorkedHours}</td>
        <td class="${record.overtimeHours !== '-' ? 'cell-success' : ''}">${record.overtimeHours}</td>
        <td>${record.baseSalaryDay}</td>
        <td class="${record.lateDeduction !== '-' ? 'cell-error' : ''}">${record.lateDeduction}</td>
        <td class="cell-success">${record.overtimeCompensation}</td>
        <td class="cell-success" style="font-weight: 700;">${record.totalSalaryDay}</td>
      </tr>
    `;
  });

  return `
    <h2 class="section-title">Reporte Personal: ${employee.name}</h2>
    <p style="color: #6b7280; margin-bottom: 20px; font-size: 14px;">
      ID: ${employee.id} | 📧 ${employee.email} | 📱 ${employee.phone}
    </p>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-label">Sueldo Base Mensual</div>
        <div class="summary-value">${employee.baseSalary}</div>
      </div>
      <div class="summary-card success">
        <div class="summary-label">Horas Trabajadas</div>
        <div class="summary-value">${employee.totalWorkedHours}</div>
      </div>
      <div class="summary-card warning">
        <div class="summary-label">Sueldo Final</div>
        <div class="summary-value">${employee.calculatedSalary}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Día</th>
          <th>Sucursal</th>
          <th>Entrada</th>
          <th>Salida</th>
          <th>Horas Trabajadas</th>
          <th>Tiempo No Laborado</th>
          <th>Tiempo Extra</th>
          <th>Sueldo Base Día</th>
          <th>Desc. Tardanza</th>
          <th>Compensación Extra</th>
          <th>Sueldo Total</th>
        </tr>
      </thead>
      <tbody>
        ${dailyRows}
      </tbody>
    </table>
  `;
}

function generateFullReportHTML(params: {
  businessName: string;
  startDate: string;
  endDate: string;
  generatedDate: string;
  reportType: string;
  content: string;
  signatureInfo?: {
    signer1: string;
    signer2: string;
  };
}): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reporte de Asistencias - Timer</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background-color: #f9fafb;
            color: #374151;
            line-height: 1.6;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background-color: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        .header {
            border-bottom: 3px solid #3b82f6;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        .logo {
            font-size: 28px;
            font-weight: 700;
            color: #1f2937;
            margin-bottom: 8px;
        }
        .logo span {
            color: #3b82f6;
        }
        .report-title {
            font-size: 24px;
            font-weight: 700;
            color: #1f2937;
            margin-bottom: 8px;
        }
        .report-info {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 30px;
            background-color: #eff6ff;
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #3b82f6;
        }
        .info-item {
            display: flex;
            flex-direction: column;
        }
        .info-label {
            font-size: 12px;
            font-weight: 600;
            color: #6b7280;
            text-transform: uppercase;
            margin-bottom: 4px;
            letter-spacing: 0.5px;
        }
        .info-value {
            font-size: 16px;
            font-weight: 600;
            color: #1f2937;
        }
        .section-title {
            font-size: 18px;
            font-weight: 700;
            color: #1f2937;
            margin-top: 30px;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e5e7eb;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
            font-size: 13px;
        }
        thead {
            background-color: #3b82f6;
            color: white;
        }
        th {
            padding: 12px;
            text-align: left;
            font-weight: 600;
            border: 1px solid #3b82f6;
        }
        td {
            padding: 12px;
            border: 1px solid #e5e7eb;
        }
        tbody tr:nth-child(even) {
            background-color: #f9fafb;
        }
        tbody tr:hover {
            background-color: #eff6ff;
        }
        .cell-date {
            font-weight: 600;
            color: #1f2937;
        }
        .cell-success {
            color: #10b981;
            font-weight: 600;
        }
        .cell-warning {
            color: #f59e0b;
            font-weight: 600;
        }
        .cell-error {
            color: #ef4444;
            font-weight: 600;
        }
        .cell-absent {
            color: #9ca3af;
            font-style: italic;
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 30px;
        }
        .summary-card {
            background-color: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 20px;
            border-left: 4px solid #3b82f6;
        }
        .summary-card.success {
            border-left-color: #10b981;
        }
        .summary-card.warning {
            border-left-color: #f59e0b;
        }
        .summary-label {
            font-size: 12px;
            font-weight: 600;
            color: #6b7280;
            text-transform: uppercase;
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }
        .summary-value {
            font-size: 24px;
            font-weight: 700;
            color: #1f2937;
        }
        .employee-section {
            page-break-inside: avoid;
            margin-bottom: 40px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 20px;
            background-color: #fafbfc;
        }
        .employee-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e5e7eb;
        }
        .employee-name {
            font-size: 16px;
            font-weight: 700;
            color: #1f2937;
        }
        .employee-meta {
            font-size: 12px;
            color: #6b7280;
        }
        .employee-stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-bottom: 15px;
        }
        .stat-mini {
            background-color: white;
            border: 1px solid #e5e7eb;
            border-radius: 4px;
            padding: 10px;
            text-align: center;
        }
        .stat-mini-label {
            font-size: 11px;
            font-weight: 600;
            color: #6b7280;
            text-transform: uppercase;
            margin-bottom: 4px;
        }
        .stat-mini-value {
            font-size: 14px;
            font-weight: 700;
            color: #1f2937;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
            text-align: center;
            color: #6b7280;
            font-size: 12px;
        }
        @media print {
            body { padding: 0; }
            .container { box-shadow: none; padding: 0; }
            .page-break { page-break-after: always; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">⏱ <span>Timer</span></div>
            <div class="report-title">Reporte de Asistencias</div>
        </div>

        <div class="report-info">
            <div class="info-item">
                <span class="info-label">Empresa</span>
                <span class="info-value">${params.businessName}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Período</span>
                <span class="info-value">${params.startDate} a ${params.endDate}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Generado</span>
                <span class="info-value">${params.generatedDate}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Tipo de Reporte</span>
                <span class="info-value">${params.reportType}</span>
            </div>
        </div>

        ${params.content}

        ${params.signatureInfo ? `
        <div class="signatures-section" style="margin-top: 60px; padding-top: 30px; border-top: 2px solid #e5e7eb;">
            <h3 style="font-size: 16px; font-weight: 700; color: #1f2937; margin-bottom: 30px; text-align: center;">FIRMAS</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 60px; margin-bottom: 40px;">
                <div style="text-align: center;">
                    <div style="border-bottom: 2px solid #1f2937; padding-bottom: 5px; margin-bottom: 10px; min-height: 60px; display: flex; align-items: flex-end; justify-content: center;">
                        <span style="font-size: 14px; color: #1f2937;">&nbsp;</span>
                    </div>
                    <p style="font-weight: 600; color: #1f2937; margin-bottom: 5px;">${params.signatureInfo.signer1}</p>
                    <p style="font-size: 12px; color: #6b7280;">Fecha: ${dayjs().format('DD [de] MMMM [de] YYYY')}</p>
                </div>
                <div style="text-align: center;">
                    <div style="border-bottom: 2px solid #1f2937; padding-bottom: 5px; margin-bottom: 10px; min-height: 60px; display: flex; align-items: flex-end; justify-content: center;">
                        <span style="font-size: 14px; color: #1f2937;">&nbsp;</span>
                    </div>
                    <p style="font-weight: 600; color: #1f2937; margin-bottom: 5px;">${params.signatureInfo.signer2}</p>
                    <p style="font-size: 12px; color: #6b7280;">Fecha: ${dayjs().format('DD [de] MMMM [de] YYYY')}</p>
                </div>
            </div>
        </div>
        ` : ''}

        <div class="legal-notice" style="margin-top: 40px; padding: 20px; background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;">
            <p style="font-size: 13px; font-weight: 700; color: #92400e; margin-bottom: 15px; text-transform: uppercase;">
                ⚠️ AVISO LEGAL - CONFIDENCIALIDAD Y RESPONSABILIDAD
            </p>
            <div style="font-size: 11px; color: #78350f; line-height: 1.8;">
                <p style="margin-bottom: 10px;">
                    El presente reporte contiene información sensible de carácter laboral y de nómina. La persona natural o jurídica que accede a este documento reconoce y es consciente de que:
                </p>
                <ol style="margin-left: 20px; margin-bottom: 10px;">
                    <li style="margin-bottom: 8px;">
                        La información aquí contenida es de carácter confidencial y restringido, siendo de uso exclusivamente interno de la organización <strong>${params.businessName}</strong>.
                    </li>
                    <li style="margin-bottom: 8px;">
                        El generador, descargador, remitente y/o firmante del presente reporte adquiere la responsabilidad plena de proteger la integridad y confidencialidad de los datos expuestos, prohibiéndose su divulgación no autorizada a terceros.
                    </li>
                    <li style="margin-bottom: 8px;">
                        Cualquier uso inapropiado, divulgación no autorizada, o mal uso de la información contenida en este documento será responsabilidad exclusiva de quien lo realice, siendo sometido a las consecuencias civiles, laborales y penales que el dueño del negocio determine conforme a la legislación vigente.
                    </li>
                    <li style="margin-bottom: 8px;">
                        Timer y sus representantes se deslindan de cualquier responsabilidad derivada del mal uso, divulgación o tratamiento indebido de la información contenida en este reporte.
                    </li>
                </ol>
                <p style="margin-top: 15px; font-weight: 600;">
                    Al generar, descargar, enviar o firmar el presente documento, usted acepta y reconoce todas las disposiciones anteriormente mencionadas.
                </p>
            </div>
        </div>

        <div class="footer" style="margin-top: 30px;">
            <p>⏱ Timer - Sistema de Control de Asistencia</p>
            <p>Generado automáticamente el ${params.generatedDate}</p>
        </div>
    </div>
</body>
</html>`;
}

function generateEmptyReportHTML(businessName: string, startDate: string, endDate: string): string {
  return generateFullReportHTML({
    businessName,
    startDate: dayjs(startDate).format('DD [de] MMMM [de] YYYY'),
    endDate: dayjs(endDate).format('DD [de] MMMM [de] YYYY'),
    generatedDate: dayjs().format('DD [de] MMMM [de] YYYY, hh:mm A'),
    reportType: 'General',
    content: '<p style="text-align: center; padding: 40px; color: #6b7280;">No se encontraron registros de asistencia para el rango de fechas seleccionado.</p>',
    signatureInfo: {
      signer1: 'Encargado de Recursos Humanos',
      signer2: `Encargado del ${businessName}`,
    },
  });
}

