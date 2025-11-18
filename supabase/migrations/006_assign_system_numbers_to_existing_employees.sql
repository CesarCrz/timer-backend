-- Asignar números del sistema a empleados existentes que no tienen número asignado
-- Este script distribuye equitativamente los empleados entre los números activos disponibles

DO $$
DECLARE
  system_num RECORD;
  employee_rec RECORD;
  current_count INT;
  total_employees INT;
  employees_per_number INT;
  remaining_employees INT;
  assigned_count INT := 0;
BEGIN
  -- Obtener el total de empleados sin número asignado
  SELECT COUNT(*) INTO total_employees
  FROM public.employees
  WHERE system_number_registered IS NULL;
  
  -- Si no hay empleados sin asignar, salir
  IF total_employees = 0 THEN
    RAISE NOTICE 'No hay empleados sin número asignado';
    RETURN;
  END IF;
  
  -- Obtener números activos ordenados por cantidad actual de empleados (ascendente)
  FOR system_num IN 
    SELECT number, max_employees, current_employees_count
    FROM public.system_numbers
    WHERE is_active = true
    ORDER BY current_employees_count ASC, number ASC
  LOOP
    -- Calcular cuántos empleados podemos asignar a este número
    current_count := system_num.current_employees_count;
    employees_per_number := LEAST(
      system_num.max_employees - current_count,
      total_employees - assigned_count
    );
    
    -- Si este número ya está lleno, continuar con el siguiente
    IF employees_per_number <= 0 THEN
      CONTINUE;
    END IF;
    
    -- Asignar empleados a este número
    FOR employee_rec IN
      SELECT id
      FROM public.employees
      WHERE system_number_registered IS NULL
      ORDER BY created_at ASC
      LIMIT employees_per_number
    LOOP
      UPDATE public.employees
      SET system_number_registered = system_num.number
      WHERE id = employee_rec.id;
      
      assigned_count := assigned_count + 1;
    END LOOP;
    
    -- Actualizar el contador del número del sistema
    UPDATE public.system_numbers
    SET current_employees_count = current_employees_count + employees_per_number
    WHERE number = system_num.number;
    
    -- Si ya asignamos todos los empleados, salir
    IF assigned_count >= total_employees THEN
      EXIT;
    END IF;
  END LOOP;
  
  RAISE NOTICE 'Asignados % empleados a números del sistema', assigned_count;
END $$;

