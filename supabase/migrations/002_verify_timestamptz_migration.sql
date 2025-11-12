-- Migration: Verify and fix TIMESTAMPTZ migration
-- This script verifies the column types and provides a safe way to ensure they are TIMESTAMPTZ

-- Step 1: Check current column types
DO $$
DECLARE
    check_in_type text;
    check_out_type text;
BEGIN
    SELECT data_type INTO check_in_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attendance_records'
      AND column_name = 'check_in_time';
    
    SELECT data_type INTO check_out_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attendance_records'
      AND column_name = 'check_out_time';
    
    RAISE NOTICE 'check_in_time type: %', check_in_type;
    RAISE NOTICE 'check_out_time type: %', check_out_type;
    
    -- If columns are not TIMESTAMPTZ, convert them
    IF check_in_type != 'timestamp with time zone' THEN
        RAISE NOTICE 'Converting check_in_time to TIMESTAMPTZ...';
        -- This will be done in the ALTER statements below
    END IF;
    
    IF check_out_type != 'timestamp with time zone' THEN
        RAISE NOTICE 'Converting check_out_time to TIMESTAMPTZ...';
        -- This will be done in the ALTER statements below
    END IF;
END $$;

-- Step 2: Convert columns to TIMESTAMPTZ if they aren't already
-- This is safe to run multiple times - it won't change anything if already TIMESTAMPTZ

-- For check_in_time
DO $$
BEGIN
    -- Check if column exists and is not already TIMESTAMPTZ
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'attendance_records'
          AND column_name = 'check_in_time'
          AND data_type != 'timestamp with time zone'
    ) THEN
        -- Add temporary column
        ALTER TABLE public.attendance_records 
          ADD COLUMN check_in_time_tz TIMESTAMPTZ;
        
        -- Migrate data (treat existing as UTC if no timezone info)
        UPDATE public.attendance_records 
        SET check_in_time_tz = check_in_time::TIMESTAMPTZ AT TIME ZONE 'UTC';
        
        -- Drop old column
        ALTER TABLE public.attendance_records 
          DROP COLUMN check_in_time;
        
        -- Rename new column
        ALTER TABLE public.attendance_records 
          RENAME COLUMN check_in_time_tz TO check_in_time;
        
        -- Add NOT NULL constraint
        ALTER TABLE public.attendance_records 
          ALTER COLUMN check_in_time SET NOT NULL;
        
        RAISE NOTICE 'check_in_time converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'check_in_time is already TIMESTAMPTZ';
    END IF;
END $$;

-- For check_out_time
DO $$
BEGIN
    -- Check if column exists and is not already TIMESTAMPTZ
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'attendance_records'
          AND column_name = 'check_out_time'
          AND data_type != 'timestamp with time zone'
    ) THEN
        -- Add temporary column
        ALTER TABLE public.attendance_records 
          ADD COLUMN check_out_time_tz TIMESTAMPTZ;
        
        -- Migrate data (treat existing as UTC if no timezone info)
        UPDATE public.attendance_records 
        SET check_out_time_tz = CASE 
            WHEN check_out_time IS NOT NULL 
            THEN check_out_time::TIMESTAMPTZ AT TIME ZONE 'UTC'
            ELSE NULL 
        END;
        
        -- Drop old column
        ALTER TABLE public.attendance_records 
          DROP COLUMN check_out_time;
        
        -- Rename new column
        ALTER TABLE public.attendance_records 
          RENAME COLUMN check_out_time_tz TO check_out_time;
        
        RAISE NOTICE 'check_out_time converted to TIMESTAMPTZ';
    ELSE
        RAISE NOTICE 'check_out_time is already TIMESTAMPTZ';
    END IF;
END $$;

-- Step 3: Verify the conversion
SELECT 
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'attendance_records'
  AND column_name IN ('check_in_time', 'check_out_time')
ORDER BY column_name;

