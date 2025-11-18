import { NextRequest } from 'next/server';
import { createServiceRoleClient } from '@/lib/utils/auth';

// Configuración
const MAX_DAYS_OLD = 7; // Cerrar registros con más de 7 días automáticamente
const BATCH_SIZE = 50; // Procesar en lotes de 50 registros
const MAX_EXECUTION_TIME_MS = 300000; // 5 minutos máximo de ejecución

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const startTime = Date.now();
  
  try {
    // Importar dayjs para manejo correcto de timezones
    const dayjs = (await import('dayjs')).default;
    const utc = (await import('dayjs/plugin/utc')).default;
    const timezone = (await import('dayjs/plugin/timezone')).default;
    dayjs.extend(utc);
    dayjs.extend(timezone);

    // Obtener la hora actual en UTC (una sola vez para toda la ejecución)
    const nowUTC = dayjs().utc();
    const maxAgeDate = nowUTC.subtract(MAX_DAYS_OLD, 'days');

    // Obtener todos los registros activos con paginación para eficiencia
    // Usar índice compuesto (status, check_in_time) si existe para mejor rendimiento
    let offset = 0;
    let hasMore = true;
    let totalProcessed = 0;
    let closedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    while (hasMore) {
      // Verificar timeout
      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        console.warn(`⏰ [AUTO-CHECKOUT] Timeout alcanzado, deteniendo procesamiento`);
        break;
      }

      // Obtener lote de registros activos
      // Incluir employee_id y branch_id para obtener horarios de employee_branches
      const { data: activeRecords, error: recordsError } = await supabase
        .from('attendance_records')
        .select('id, employee_id, branch_id, check_in_time, is_auto_closed, branch:branches(id, business_hours_start, business_hours_end, timezone, status)')
        .eq('status', 'active')
        .order('check_in_time', { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1);

      if (recordsError) {
        console.error('❌ [AUTO-CHECKOUT] Error obteniendo registros activos:', recordsError);
        return Response.json({ error: 'Failed to fetch active records' }, { status: 500 });
      }

      if (!activeRecords || activeRecords.length === 0) {
        hasMore = false;
        break;
      }

      totalProcessed += activeRecords.length;
      console.log(`📊 [AUTO-CHECKOUT] Procesando lote: ${activeRecords.length} registros (Total: ${totalProcessed})`);

      // Agrupar por employee_id para detectar múltiples registros activos del mismo empleado
      const recordsByEmployee: Record<string, any[]> = {};
      activeRecords.forEach((record: any) => {
        if (!recordsByEmployee[record.employee_id]) {
          recordsByEmployee[record.employee_id] = [];
        }
        recordsByEmployee[record.employee_id].push(record);
      });

      // Procesar cada registro
      const updates: Array<{ id: string; checkOutTime: string }> = [];

      for (const record of activeRecords) {
        try {
          // VALIDACIÓN 1: Verificar que el registro tenga branch asociado
          // Supabase puede devolver branch como objeto o array, normalizar
          const branch = Array.isArray(record.branch) ? record.branch[0] : record.branch;
          
          if (!branch || !branch.id) {
            console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} no tiene branch asociado, saltando...`);
            skippedCount++;
            errors.push(`Registro ${record.id}: Branch no encontrado`);
            continue;
          }

          // VALIDACIÓN 2: Verificar que la sucursal esté activa
          if (branch.status !== 'active') {
            console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} pertenece a sucursal inactiva, saltando...`);
            skippedCount++;
            continue;
          }

          // VALIDACIÓN 3: Obtener horario (prioridad: employee_branches > sucursal)
          const branchTimezone = branch?.timezone || 'America/Mexico_City';
          
          // Obtener horario específico del empleado para esta sucursal desde employee_branches
          const { data: employeeBranch } = await supabase
            .from('employee_branches')
            .select('employees_hours_start, employees_hours_end')
            .eq('employee_id', record.employee_id)
            .eq('branch_id', record.branch_id)
            .eq('status', 'active')
            .maybeSingle();
          
          // PRIORIDAD: Usar horario del empleado en esta sucursal si existe, sino usar horario de la sucursal
          let hoursStart: string | null = null;
          let hoursEnd: string | null = null;
          
          if (employeeBranch?.employees_hours_start && employeeBranch?.employees_hours_end) {
            // Usar horario específico del empleado para esta sucursal
            hoursStart = employeeBranch.employees_hours_start;
            hoursEnd = employeeBranch.employees_hours_end;
          } else if (branch?.business_hours_start && branch?.business_hours_end) {
            // Usar horario de la sucursal
            hoursStart = branch.business_hours_start;
            hoursEnd = branch.business_hours_end;
          }
          
          if (!hoursEnd || !hoursStart) {
            console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} no tiene horario configurado (ni empleado ni sucursal), saltando...`);
            skippedCount++;
            errors.push(`Registro ${record.id}: Horario no configurado`);
            continue;
          }

          // VALIDACIÓN 4: Verificar formato de horas
          const hoursStartMatch = hoursStart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
          const hoursEndMatch = hoursEnd.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
          
          if (!hoursStartMatch || !hoursEndMatch) {
            console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} tiene formato de horas inválido, saltando...`);
            skippedCount++;
            errors.push(`Registro ${record.id}: Formato de horas inválido`);
            continue;
          }

          // Convertir check_in_time al timezone de la sucursal
          const checkInDate = dayjs.utc(record.check_in_time).tz(branchTimezone);
          
          // VALIDACIÓN 5: Verificar que check_in_time sea válido
          if (!checkInDate.isValid()) {
            console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} tiene check_in_time inválido, saltando...`);
            skippedCount++;
            errors.push(`Registro ${record.id}: check_in_time inválido`);
            continue;
          }

          // Obtener la hora actual en el timezone de la sucursal
          const nowInBranchTZ = nowUTC.tz(branchTimezone);
          
          // Parsear horas de inicio y fin (usando el horario determinado arriba)
          const startHour = parseInt(hoursStartMatch[1]);
          const startMinute = parseInt(hoursStartMatch[2]);
          const endHour = parseInt(hoursEndMatch[1]);
          const endMinute = parseInt(hoursEndMatch[2]);
          
          // VALIDACIÓN 6: Verificar que las horas sean válidas (0-23 para horas, 0-59 para minutos)
          if (startHour < 0 || startHour > 23 || startMinute < 0 || startMinute > 59 ||
              endHour < 0 || endHour > 23 || endMinute < 0 || endMinute > 59) {
            console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} tiene horas fuera de rango, saltando...`);
            skippedCount++;
            errors.push(`Registro ${record.id}: Horas fuera de rango`);
            continue;
          }
          
          // Determinar si la hora de cierre es del mismo día o del día siguiente
          // Si business_hours_end < business_hours_start (ej: cierra 01:00, abre 08:00)
          // entonces el cierre es del día siguiente al check-in
          const closingIsNextDay = endHour < startHour || (endHour === startHour && endMinute < startMinute);
          
          // Calcular la hora de cierre esperada
          let closingTimeInBranchTZ = checkInDate
            .clone()
            .hour(endHour)
            .minute(endMinute)
            .second(0)
            .millisecond(0);
          
          // Si el cierre es del día siguiente, agregar un día
          if (closingIsNextDay) {
            closingTimeInBranchTZ = closingTimeInBranchTZ.add(1, 'day');
          }
          
          // VALIDACIÓN 7: Verificar si el registro es muy antiguo (más de MAX_DAYS_OLD días)
          // Si es muy antiguo, cerrarlo de todas formas
          const checkInUTC = dayjs.utc(record.check_in_time);
          const isVeryOld = checkInUTC.isBefore(maxAgeDate);
          
          // VALIDACIÓN 8: Verificar si ya pasó la hora de cierre
          const hasPassedClosingTime = nowInBranchTZ.isAfter(closingTimeInBranchTZ) || nowInBranchTZ.isSame(closingTimeInBranchTZ);
          
          // VALIDACIÓN 9: Verificar que no haya múltiples registros activos del mismo empleado
          // Si hay múltiples, cerrar solo el más antiguo y marcar los demás como error
          const employeeRecords = recordsByEmployee[record.employee_id] || [];
          if (employeeRecords.length > 1) {
            // Ordenar por check_in_time
            employeeRecords.sort((a, b) => 
              dayjs.utc(a.check_in_time).valueOf() - dayjs.utc(b.check_in_time).valueOf()
            );
            
            // Si este no es el más antiguo, saltarlo (el más antiguo se procesará primero)
            if (record.id !== employeeRecords[0].id) {
              console.warn(`⚠️ [AUTO-CHECKOUT] Registro ${record.id} es duplicado (empleado tiene ${employeeRecords.length} registros activos), saltando...`);
              skippedCount++;
              errors.push(`Registro ${record.id}: Múltiples registros activos del mismo empleado`);
              continue;
            }
          }

          // Decidir si cerrar el registro
          const shouldClose = isVeryOld || hasPassedClosingTime;
          
          // Log detallado solo si es necesario (reducir logs en producción)
          if (shouldClose || process.env.NODE_ENV === 'development') {
            console.log(`🔍 [AUTO-CHECKOUT] Registro ${record.id}:`, {
              checkIn: checkInDate.format('YYYY-MM-DD HH:mm:ss'),
              closingTime: closingTimeInBranchTZ.format('YYYY-MM-DD HH:mm:ss'),
              now: nowInBranchTZ.format('YYYY-MM-DD HH:mm:ss'),
              hasPassedClosingTime,
              isVeryOld,
              shouldClose,
              branchTimezone,
            });
          }

          if (!shouldClose) {
            // Log solo en desarrollo para reducir ruido
            if (process.env.NODE_ENV === 'development') {
              console.log(`⏳ [AUTO-CHECKOUT] Registro ${record.id} aún no ha pasado la hora de cierre (${closingTimeInBranchTZ.format('HH:mm')}), saltando...`);
            }
            skippedCount++;
            continue;
          }

          // VALIDACIÓN 10: Verificar que check_out_time no sea anterior a check_in_time
          // (aunque esto no debería pasar, es una validación de seguridad)
          const autoCheckOutUTC = closingTimeInBranchTZ.utc();
          if (autoCheckOutUTC.isBefore(checkInUTC)) {
            console.error(`❌ [AUTO-CHECKOUT] Registro ${record.id}: check_out calculado es anterior a check_in, usando check_in + 1 hora como fallback`);
            // Fallback: usar check_in + 1 hora
            const fallbackCheckOut = checkInUTC.add(1, 'hour');
            updates.push({
              id: record.id,
              checkOutTime: fallbackCheckOut.format('YYYY-MM-DD HH:mm:ss'),
              isAutoClosed: true,
            });
          } else {
            updates.push({
              id: record.id,
              checkOutTime: autoCheckOutUTC.format('YYYY-MM-DD HH:mm:ss'),
              isAutoClosed: true, // Marcar que fue cerrado automáticamente
            });
          }
          
          closedCount++;
        } catch (error: any) {
          console.error(`❌ [AUTO-CHECKOUT] Error procesando registro ${record.id}:`, error);
          errorCount++;
          errors.push(`Registro ${record.id}: ${error.message || 'Error desconocido'}`);
        }
      }

      // Ejecutar actualizaciones en lotes para mejor rendimiento
      if (updates.length > 0) {
        // Procesar en lotes más pequeños para evitar timeouts
        const updateBatches: Array<Array<{ id: string; checkOutTime: string; isAutoClosed?: boolean }>> = [];
        for (let i = 0; i < updates.length; i += 20) {
          updateBatches.push(updates.slice(i, i + 20));
        }

        for (const batch of updateBatches) {
          try {
            // Usar transacción implícita con Promise.all para mejor rendimiento
            const batchUpdates = batch.map(({ id, checkOutTime, isAutoClosed }) =>
              supabase
                .from('attendance_records')
                .update({ 
                  check_out_time: checkOutTime, 
                  status: 'completed', 
                  is_auto_closed: isAutoClosed !== undefined ? isAutoClosed : true, // Siempre marcar como auto-closed
                  updated_at: new Date().toISOString(),
                })
                .eq('id', id)
                .eq('status', 'active') // Solo actualizar si aún está activo (evitar race conditions)
            );

            const results = await Promise.allSettled(batchUpdates);
            
            // Contar éxitos y fallos
            results.forEach((result, index) => {
              if (result.status === 'rejected') {
                console.error(`❌ [AUTO-CHECKOUT] Error actualizando registro ${batch[index].id}:`, result.reason);
                errorCount++;
              }
            });
          } catch (batchError: any) {
            console.error(`❌ [AUTO-CHECKOUT] Error en lote de actualizaciones:`, batchError);
            errorCount += batch.length;
          }
        }
      }

      // Verificar si hay más registros
      hasMore = activeRecords.length === BATCH_SIZE;
      offset += BATCH_SIZE;
    }

    const executionTime = Date.now() - startTime;
    console.log(`✅ [AUTO-CHECKOUT] Procesamiento completado:`, {
      totalProcessed,
      closed: closedCount,
      skipped: skippedCount,
      errors: errorCount,
      executionTimeMs: executionTime,
    });

    return Response.json({ 
      success: true, 
      closed: closedCount,
      skipped: skippedCount,
      errors: errorCount,
      total: totalProcessed,
      executionTimeMs: executionTime,
      errorDetails: errors.length > 0 && errors.length <= 10 ? errors : undefined, // Solo incluir detalles si hay pocos errores
    });
  } catch (error: any) {
    console.error('❌ [AUTO-CHECKOUT] Error general:', error);
    return Response.json({ error: 'Failed to auto-close records' }, { status: 500 });
  }
}







