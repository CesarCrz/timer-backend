import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export type AttendanceRecord = {
  check_in_time: string;
  check_out_time: string;
  is_late?: boolean;
  branch: {
    name: string;
    business_hours_start: string;
    timezone: string;
    tolerance_minutes?: number;
  };
  employee: {
    hourly_rate: number;
  };
};

export type DailyCalculation = {
  date: string;
  check_in: string;
  check_out: string;
  hours_worked: number;
  late_minutes: number;
  overtime_hours: number;
  base_payment: number;
  payment_with_late: number;
  overtime_payment: number;
  total_payment: number;
  branch_name: string;
  branch_hours_start?: string;
  branch_hours_end?: string;
  branch_location?: string;
  branch_timezone?: string;
  is_late: boolean;
};

export function calculateAttendanceMetrics(record: AttendanceRecord): DailyCalculation {
  const tz = record.branch.timezone;
  // Los timestamps vienen de la BD sin timezone, los interpretamos como UTC
  // y luego convertimos al timezone de la sucursal
  const checkIn = dayjs.utc(record.check_in_time).tz(tz);
  const checkOut = dayjs.utc(record.check_out_time).tz(tz);

  const [startHour, startMinute] = record.branch.business_hours_start.split(':');
  const scheduledStart = checkIn
    .clone()
    .hour(parseInt(startHour))
    .minute(parseInt(startMinute))
    .second(0);

  const totalMinutes = checkOut.diff(checkIn, 'minute');
  const hoursWorked = totalMinutes / 60;
  
  // Calcular late_minutes considerando la tolerancia
  const toleranceMinutes = record.branch.tolerance_minutes || 0;
  const allowedStart = scheduledStart.add(toleranceMinutes, 'minute');
  const lateMinutes = checkIn.isAfter(allowedStart) ? Math.max(0, checkIn.diff(allowedStart, 'minute')) : 0;
  
  const overtimeHours = Math.max(0, hoursWorked - 8);
  const effectiveHours = Math.max(0, hoursWorked - lateMinutes / 60);

  const hourlyRate = record.employee.hourly_rate;
  const basePayment = hourlyRate * 8;
  const paymentWithLate = hourlyRate * effectiveHours;
  const overtimePayment = hourlyRate * overtimeHours;
  const totalPayment = paymentWithLate + overtimePayment;

  // Usar is_late de la BD si está disponible, sino calcularlo según tolerancia
  const isLate = record.is_late !== undefined ? record.is_late : checkIn.isAfter(allowedStart);

  return {
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
    branch_hours_start: (record.branch as any).business_hours_start,
    branch_hours_end: (record.branch as any).business_hours_end,
    branch_location: (record.branch as any).address,
    branch_timezone: record.branch.timezone,
    is_late: isLate,
  };
}







