-- Migration: Change attendance_records timestamps to TIMESTAMPTZ
-- This ensures timestamps are stored with timezone information

-- Step 1: Add new columns with TIMESTAMPTZ type
ALTER TABLE public.attendance_records 
  ADD COLUMN IF NOT EXISTS check_in_time_tz TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS check_out_time_tz TIMESTAMPTZ;

-- Step 2: Migrate existing data (assuming existing timestamps are in UTC)
-- Convert existing TIMESTAMP to TIMESTAMPTZ by treating them as UTC
UPDATE public.attendance_records 
SET 
  check_in_time_tz = check_in_time::TIMESTAMPTZ AT TIME ZONE 'UTC',
  check_out_time_tz = CASE 
    WHEN check_out_time IS NOT NULL 
    THEN check_out_time::TIMESTAMPTZ AT TIME ZONE 'UTC'
    ELSE NULL 
  END;

-- Step 3: Drop old columns
ALTER TABLE public.attendance_records 
  DROP COLUMN IF EXISTS check_in_time,
  DROP COLUMN IF EXISTS check_out_time;

-- Step 4: Rename new columns to original names
ALTER TABLE public.attendance_records 
  RENAME COLUMN check_in_time_tz TO check_in_time;

ALTER TABLE public.attendance_records 
  RENAME COLUMN check_out_time_tz TO check_out_time;

-- Step 5: Add NOT NULL constraint back to check_in_time
ALTER TABLE public.attendance_records 
  ALTER COLUMN check_in_time SET NOT NULL;

-- Step 6: Recreate index (if needed, it should still work but let's be explicit)
DROP INDEX IF EXISTS idx_attendance_check_in;
CREATE INDEX IF NOT EXISTS idx_attendance_check_in ON public.attendance_records(check_in_time);

-- Verify the change
COMMENT ON COLUMN public.attendance_records.check_in_time IS 'Check-in time with timezone (TIMESTAMPTZ)';
COMMENT ON COLUMN public.attendance_records.check_out_time IS 'Check-out time with timezone (TIMESTAMPTZ)';

