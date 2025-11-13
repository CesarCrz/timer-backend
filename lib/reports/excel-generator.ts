import ExcelJS from 'exceljs';

export async function generateExcelReport(reportData: any[], startDate: string, endDate: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  
  // Hoja de resumen
  const summarySheet = workbook.addWorksheet('Resumen');
  summarySheet.columns = [
    { header: 'Empleado', key: 'employee', width: 30 },
    { header: 'Tarifa/Hora', key: 'rate', width: 15 },
    { header: 'Días Trabajados', key: 'days', width: 15 },
    { header: 'Total Horas', key: 'hours', width: 15 },
    { header: 'Tardanzas (min)', key: 'late', width: 15 },
    { header: 'Tiempo Extra (h)', key: 'overtime', width: 15 },
    { header: 'Total a Pagar', key: 'payment', width: 18 },
  ];

  // Estilo para encabezados
  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2563EB' },
  };
  summarySheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  reportData.forEach((emp) => {
    summarySheet.addRow({
      employee: emp.employee_name,
      rate: emp.hourly_rate,
      days: emp.summary.total_days,
      hours: parseFloat(emp.summary.total_hours),
      late: parseFloat(emp.summary.total_late_minutes),
      overtime: parseFloat(emp.summary.total_overtime),
      payment: parseFloat(emp.summary.total_payment),
    });
  });

  // Formato de moneda para tarifa y pago
  summarySheet.getColumn('rate').numFmt = '$#,##0.00';
  summarySheet.getColumn('payment').numFmt = '$#,##0.00';

  // Agregar fila de totales
  const totalRow = summarySheet.addRow({
    employee: 'TOTAL',
    rate: '',
    days: reportData.reduce((sum, emp) => sum + emp.summary.total_days, 0),
    hours: reportData.reduce((sum, emp) => sum + parseFloat(emp.summary.total_hours), 0),
    late: reportData.reduce((sum, emp) => sum + parseFloat(emp.summary.total_late_minutes), 0),
    overtime: reportData.reduce((sum, emp) => sum + parseFloat(emp.summary.total_overtime), 0),
    payment: reportData.reduce((sum, emp) => sum + parseFloat(emp.summary.total_payment), 0),
  });
  totalRow.font = { bold: true };
  totalRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF3F4F6' },
  };
  totalRow.getCell('payment').numFmt = '$#,##0.00';

  // Hoja detallada por empleado
  reportData.forEach((emp) => {
    const sheet = workbook.addWorksheet(emp.employee_name.substring(0, 31)); // Excel limita a 31 caracteres
    
    sheet.columns = [
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Sucursal', key: 'branch', width: 20 },
      { header: 'Entrada', key: 'check_in', width: 10 },
      { header: 'Salida', key: 'check_out', width: 10 },
      { header: 'Horas Trabajadas', key: 'hours', width: 15 },
      { header: 'Tardanza (min)', key: 'late', width: 15 },
      { header: 'Tiempo Extra (h)', key: 'overtime', width: 15 },
      { header: 'Pago Base', key: 'base', width: 15 },
      { header: 'Pago con Tardanza', key: 'with_late', width: 18 },
      { header: 'Pago Extra', key: 'overtime_pay', width: 15 },
      { header: 'Total Pago', key: 'total', width: 15 },
    ];

    // Estilo para encabezados
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' },
    };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    emp.daily_breakdown.forEach((day: any) => {
      const row = sheet.addRow({
        date: day.date,
        branch: day.branch_name || 'Sin sucursal',
        check_in: day.check_in,
        check_out: day.check_out,
        hours: parseFloat(day.hours_worked),
        late: parseFloat(day.late_minutes),
        overtime: parseFloat(day.overtime_hours),
        base: parseFloat(day.base_payment),
        with_late: parseFloat(day.payment_with_late),
        overtime_pay: parseFloat(day.overtime_payment),
        total: parseFloat(day.total_payment),
      });

      // Resaltar filas con tardanza
      if (day.is_late) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF2F2' },
        };
        row.getCell('late').font = { color: { argb: 'FFDC2626' }, bold: true };
      }
    });

    // Formato de moneda para columnas de pago
    ['base', 'with_late', 'overtime_pay', 'total'].forEach((col) => {
      sheet.getColumn(col).numFmt = '$#,##0.00';
    });

    // Agregar fila de resumen del empleado
    const empSummaryRow = sheet.addRow({
      date: 'RESUMEN',
      branch: '',
      check_in: '',
      check_out: '',
      hours: parseFloat(emp.summary.total_hours),
      late: parseFloat(emp.summary.total_late_minutes),
      overtime: parseFloat(emp.summary.total_overtime),
      base: '',
      with_late: '',
      overtime_pay: '',
      total: parseFloat(emp.summary.total_payment),
    });
    empSummaryRow.font = { bold: true };
    empSummaryRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEFF6FF' },
    };
    empSummaryRow.getCell('total').numFmt = '$#,##0.00';
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

