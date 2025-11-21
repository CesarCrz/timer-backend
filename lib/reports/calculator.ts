import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export type AttendanceRecord = {
  check_in_time: string;
  check_out_time: string;
  is_late?: boolean;
  is_auto_closed?: boolean;
  branch: {
    name: string;
    business_hours_start: string;
    business_hours_end?: string;
    timezone: string;
    tolerance_minutes?: number;
    address?: string;
  };
  employee: {
    hourly_rate: number;
    employees_hours_start?: string | null;
    employees_hours_end?: string | null;
    tolerance_minutes?: number | null;
  };
};

export type DailyCalculation = {
  date: string;
  check_in: string;
  check_out: string;
  hours_worked: number;
  late_minutes: number;
  unpaid_minutes?: number; // Tiempo no laborado
  overtime_hours: number;
  base_payment: number;
  payment_with_late: number;
  late_deduction?: number; // Desc. Tardanza (equivalente monetario)
  overtime_payment: number;
  total_payment: number;
  branch_name: string;
  branch_hours_start?: string;
  branch_hours_end?: string;
  branch_location?: string;
  branch_timezone?: string;
  is_late: boolean;
  is_auto_closed?: boolean; // Si el sistema marcó la salida automáticamente
};

export function calculateAttendanceMetrics(record: AttendanceRecord): DailyCalculation {
  const tz = record.branch.timezone;
  // Los timestamps vienen de la BD sin timezone, los interpretamos como UTC
  // y luego convertimos al timezone de la sucursal
  const checkIn = dayjs.utc(record.check_in_time).tz(tz);
  const checkOut = dayjs.utc(record.check_out_time).tz(tz);

  // PRIORIDAD: Usar horario del empleado si existe, sino usar horario de la sucursal
  let scheduledStart: dayjs.Dayjs;
  let scheduledEnd: dayjs.Dayjs | null = null;
  let toleranceMinutes = 0;
  let hoursStart: string;
  let hoursEnd: string | undefined;

  if (record.employee.employees_hours_start && record.employee.employees_hours_end) {
    // Usar horario específico del empleado
    hoursStart = record.employee.employees_hours_start;
    hoursEnd = record.employee.employees_hours_end;
    const [startHour, startMinute] = hoursStart.split(':');
    scheduledStart = checkIn
      .clone()
      .hour(parseInt(startHour))
      .minute(parseInt(startMinute))
      .second(0);
    
    // Hora de fin programada
    const [endHour, endMinute] = hoursEnd.split(':');
    scheduledEnd = checkIn
      .clone()
      .hour(parseInt(endHour))
      .minute(parseInt(endMinute))
      .second(0);
    
    // Usar tolerancia del empleado si existe, sino usar la de la sucursal
    toleranceMinutes = record.employee.tolerance_minutes !== null && record.employee.tolerance_minutes !== undefined
      ? record.employee.tolerance_minutes
      : (record.branch.tolerance_minutes || 0);
  } else {
    // Usar horario de la sucursal
    hoursStart = record.branch.business_hours_start;
    hoursEnd = record.branch.business_hours_end;
    const [startHour, startMinute] = hoursStart.split(':');
    scheduledStart = checkIn
      .clone()
      .hour(parseInt(startHour))
      .minute(parseInt(startMinute))
      .second(0);
    
    if (hoursEnd) {
      const [endHour, endMinute] = hoursEnd.split(':');
      scheduledEnd = checkIn
        .clone()
        .hour(parseInt(endHour))
        .minute(parseInt(endMinute))
        .second(0);
    }
    
    toleranceMinutes = record.branch.tolerance_minutes || 0;
  }

  const totalMinutes = checkOut.diff(checkIn, 'minute');
  const hoursWorked = totalMinutes / 60;
  
  // Calcular tiempo no laborado: diferencia entre check-in y hora de entrada programada
  // Si llegó tarde, el tiempo no laborado es la diferencia entre check-in y scheduledStart
  const allowedStart = scheduledStart.add(toleranceMinutes, 'minute');
  const lateMinutes = checkIn.isAfter(allowedStart) ? Math.max(0, checkIn.diff(allowedStart, 'minute')) : 0;
  
  // Tiempo no laborado = minutos de tardanza (si llegó después de la hora programada + tolerancia)
  const unpaidMinutes = lateMinutes;
  
  // Calcular tiempo extra: horas después de 8 horas trabajadas
  const overtimeHours = Math.max(0, hoursWorked - 8);
  
  // Horas efectivas trabajadas (sin contar el tiempo no laborado)
  const effectiveHours = Math.max(0, hoursWorked - (unpaidMinutes / 60));

  const hourlyRate = record.employee.hourly_rate;
  
  // Sueldo base día: 8 horas * tarifa por hora (para mostrar en reporte)
  const basePayment = hourlyRate * 8;
  
  // Desc. Tardanza: equivalente monetario del tiempo no laborado (para mostrar en reporte)
  const lateDeduction = unpaidMinutes > 0 ? hourlyRate * (unpaidMinutes / 60) : 0;
  
  // NUEVA LÓGICA según requerimientos:
  // Sueldo Total = horas trabajadas * tarifa por hora (máximo 8 horas regulares)
  // Si trabajó más de 8 horas, las horas extras se calculan por separado
  const regularHours = Math.min(hoursWorked, 8); // Máximo 8 horas para sueldo regular
  const overtimeHoursForPayment = Math.max(0, hoursWorked - 8); // Horas después de 8
  
  // Sueldo Total: solo las primeras 8 horas (o menos) * tarifa (sin descuentos)
  const totalPayment = hourlyRate * regularHours;
  
  // Total horas extras: tiempo trabajado después de 8 horas * tarifa (solo informativo, opcional pagar)
  const overtimePayment = hourlyRate * overtimeHoursForPayment;
  
  // Mantener paymentWithLate para compatibilidad (pero no se usa en Sueldo Total)
  const paymentWithLate = hourlyRate * effectiveHours;

  // Usar is_late de la BD si está disponible, sino calcularlo según tolerancia
  const isLate = record.is_late !== undefined ? record.is_late : checkIn.isAfter(allowedStart);

  const result: DailyCalculation = {
    date: checkIn.format('DD/MM/YYYY'),
    check_in: checkIn.format('HH:mm'),
    check_out: checkOut.format('HH:mm'),
    hours_worked: parseFloat(hoursWorked.toFixed(2)),
    late_minutes: parseFloat(lateMinutes.toFixed(0)),
    overtime_hours: parseFloat(overtimeHours.toFixed(2)),
    base_payment: parseFloat(basePayment.toFixed(2)),
    payment_with_late: parseFloat(paymentWithLate.toFixed(2)),
    overtime_payment: parseFloat(overtimePayment.toFixed(2)),
    total_payment: parseFloat(totalPayment.toFixed(2)),
    branch_name: record.branch.name,
    branch_hours_start: hoursStart,
    branch_hours_end: hoursEnd,
    branch_location: record.branch.address,
    branch_timezone: record.branch.timezone,
    is_late: isLate,
    // Agregar campos adicionales para el reporte
    unpaid_minutes: parseFloat(unpaidMinutes.toFixed(0)),
    late_deduction: parseFloat(lateDeduction.toFixed(2)),
    is_auto_closed: record.is_auto_closed || false,
  };
  
  return result;
}







