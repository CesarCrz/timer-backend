export function generateReportHTML(reportData: any[], startDate: string, endDate: string, currency: string = 'MXN'): string {
  if (!reportData || reportData.length === 0) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Reporte de Asistencia</title>
</head>
<body>
  <h1>Reporte de Asistencia</h1>
  <p>No se encontraron registros de asistencia para el rango de fechas seleccionado.</p>
</body>
</html>`;
  }
  
  const totalEmployees = reportData.length;
  const totalDays = reportData.reduce((sum, emp) => sum + emp.summary.total_days, 0);
  const totalPayment = reportData.reduce((sum, emp) => sum + parseFloat(emp.summary.total_payment), 0);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency }).format(amount);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  const formatTimeWorked = (hours: number) => {
    const totalMinutes = Math.floor(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}h ${m}m`;
  };

  let employeesHTML = '';
  reportData.forEach((emp, idx) => {
    let dailyRows = '';
    emp.daily_breakdown.forEach((day: any) => {
      dailyRows += `
        <tr class="${day.is_late ? 'late-row' : ''}">
          <td>${day.date}</td>
          <td>${day.check_in}</td>
          <td>${day.check_out}</td>
          <td>${formatTimeWorked(day.hours_worked)}</td>
          <td class="${day.is_late ? 'late-cell' : ''}">${day.late_minutes > 0 ? `${day.late_minutes} min` : '-'}</td>
          <td>${day.overtime_hours > 0 ? day.overtime_hours : '-'}</td>
          <td>${formatCurrency(parseFloat(day.total_payment))}</td>
        </tr>
      `;
    });

    employeesHTML += `
      <div class="employee-section">
        <div class="employee-header">
          <h3>${emp.employee_name}</h3>
          <div class="employee-meta">
            <span>Tarifa: ${formatCurrency(emp.hourly_rate)}/hora</span>
          </div>
        </div>
        <table class="daily-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Entrada</th>
              <th>Salida</th>
              <th>Horas</th>
              <th>Tardanza</th>
              <th>Extra</th>
              <th>Pago</th>
            </tr>
          </thead>
          <tbody>
            ${dailyRows}
          </tbody>
        </table>
        <div class="employee-summary">
          <div class="summary-item">
            <span class="label">Días trabajados:</span>
            <span class="value">${emp.summary.total_days}</span>
          </div>
          <div class="summary-item">
            <span class="label">Total horas:</span>
            <span class="value">${emp.summary.total_hours}</span>
          </div>
          <div class="summary-item">
            <span class="label">Tardanzas:</span>
            <span class="value ${emp.summary.late_days > 0 ? 'warning' : ''}">${emp.summary.late_days} días (${emp.summary.total_late_minutes} min)</span>
          </div>
          <div class="summary-item">
            <span class="label">Tiempo extra:</span>
            <span class="value">${emp.summary.total_overtime} horas</span>
          </div>
          <div class="summary-item total-payment">
            <span class="label">Total a pagar:</span>
            <span class="value">${formatCurrency(parseFloat(emp.summary.total_payment))}</span>
          </div>
        </div>
      </div>
    `;
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reporte de Asistencia - ${formatDate(startDate)} a ${formatDate(endDate)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      color: #1f2937;
      background: #ffffff;
      padding: 40px;
      line-height: 1.6;
    }
    .header {
      border-bottom: 3px solid #2563eb;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .header h1 {
      color: #2563eb;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .header .subtitle {
      color: #6b7280;
      font-size: 14px;
    }
    .summary-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 40px;
    }
    .summary-card {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      color: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .summary-card .label {
      font-size: 12px;
      opacity: 0.9;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      display: block;
    }
    .summary-card .value {
      font-size: 24px;
      font-weight: 700;
    }
    .employee-section {
      margin-bottom: 50px;
      page-break-inside: avoid;
    }
    .employee-header {
      background: #f9fafb;
      padding: 16px 20px;
      border-left: 4px solid #2563eb;
      margin-bottom: 16px;
      border-radius: 8px;
    }
    .employee-header h3 {
      color: #111827;
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .employee-meta {
      color: #6b7280;
      font-size: 14px;
    }
    .daily-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .daily-table thead {
      background: #2563eb;
      color: white;
    }
    .daily-table th {
      padding: 12px;
      text-align: left;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    .daily-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #e5e7eb;
    }
    .daily-table tbody tr:hover {
      background: #f9fafb;
    }
    .daily-table tbody tr:last-child td {
      border-bottom: none;
    }
    .late-row {
      background: #fef2f2;
    }
    .late-cell {
      color: #dc2626;
      font-weight: 600;
    }
    .employee-summary {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      padding: 20px;
      background: #f9fafb;
      border-radius: 8px;
      margin-top: 16px;
    }
    .summary-item {
      display: flex;
      flex-direction: column;
    }
    .summary-item .label {
      font-size: 11px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .summary-item .value {
      font-size: 16px;
      font-weight: 600;
      color: #111827;
    }
    .summary-item .value.warning {
      color: #dc2626;
    }
    .summary-item.total-payment {
      grid-column: span 1;
    }
    .summary-item.total-payment .value {
      font-size: 20px;
      color: #2563eb;
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
      body {
        padding: 20px;
      }
      .employee-section {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Reporte de Asistencia</h1>
    <div class="subtitle">${formatDate(startDate)} - ${formatDate(endDate)}</div>
  </div>

  <div class="summary-cards">
    <div class="summary-card">
      <span class="label">Empleados</span>
      <span class="value">${totalEmployees}</span>
    </div>
    <div class="summary-card">
      <span class="label">Días trabajados</span>
      <span class="value">${totalDays}</span>
    </div>
    <div class="summary-card">
      <span class="label">Total horas</span>
      <span class="value">${reportData.reduce((sum, emp) => sum + parseFloat(emp.summary.total_hours), 0).toFixed(1)}</span>
    </div>
    <div class="summary-card">
      <span class="label">Total a pagar</span>
      <span class="value">${formatCurrency(totalPayment)}</span>
    </div>
  </div>

  ${employeesHTML}

  <div class="footer">
    <p>Generado el ${new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
    <p>Timer - Sistema de Control de Asistencia</p>
  </div>
</body>
</html>`;
}

