import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export type AttendanceRecord = {
  check_in_time: string;
  check_out_time: string;
  branch: {
    business_hours_start: string;
    timezone: string;
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
  is_late: boolean;
};

export function calculateAttendanceMetrics(record: AttendanceRecord): DailyCalculation {
  const tz = record.branch.timezone;
  const checkIn = dayjs(record.check_in_time).tz(tz);
  const checkOut = dayjs(record.check_out_time).tz(tz);

  const [startHour, startMinute] = record.branch.business_hours_start.split(':');
  const scheduledStart = checkIn
    .clone()
    .hour(parseInt(startHour))
    .minute(parseInt(startMinute))
    .second(0);

  const totalMinutes = checkOut.diff(checkIn, 'minute');
  const hoursWorked = totalMinutes / 60;
  const lateMinutes = Math.max(0, checkIn.diff(scheduledStart, 'minute'));
  const overtimeHours = Math.max(0, hoursWorked - 8);
  const effectiveHours = Math.max(0, hoursWorked - lateMinutes / 60);

  const hourlyRate = record.employee.hourly_rate;
  const basePayment = hourlyRate * 8;
  const paymentWithLate = hourlyRate * effectiveHours;
  const overtimePayment = hourlyRate * overtimeHours;
  const totalPayment = paymentWithLate + overtimePayment;

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
    is_late: lateMinutes > 0,
  };
}







