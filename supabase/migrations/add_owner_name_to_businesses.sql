-- Agregar campo owner_name a businesses (referencia al display name de auth.users)
-- El display name se obtiene de user_metadata->>'full_name' o raw_user_meta_data->>'full_name'
ALTER TABLE public.businesses 
ADD COLUMN IF NOT EXISTS owner_name TEXT;

-- Crear función para actualizar owner_name cuando se crea o actualiza un business
-- NOTA: Esta función solo se ejecutará si owner_name no se proporciona explícitamente
CREATE OR REPLACE FUNCTION public.update_business_owner_name()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo actualizar si owner_name no fue proporcionado explícitamente
  IF NEW.owner_name IS NULL THEN
    -- Intentar obtener el full_name del usuario desde auth.users
    -- Usar SECURITY DEFINER para tener permisos de lectura en auth.users
    BEGIN
      SELECT COALESCE(
        (raw_user_meta_data->>'full_name')::text,
        (user_metadata->>'full_name')::text,
        email
      ) INTO NEW.owner_name
      FROM auth.users
      WHERE id = NEW.owner_id;
    EXCEPTION WHEN OTHERS THEN
      -- Si falla, dejar owner_name como NULL
      NEW.owner_name := NULL;
    END;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Crear trigger para actualizar owner_name automáticamente (solo si no se proporciona)
DROP TRIGGER IF EXISTS trigger_update_business_owner_name ON public.businesses;
CREATE TRIGGER trigger_update_business_owner_name
  BEFORE INSERT OR UPDATE OF owner_id ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.update_business_owner_name();

-- Actualizar owner_name para businesses existentes
UPDATE public.businesses b
SET owner_name = COALESCE(
  (SELECT (raw_user_meta_data->>'full_name')::text FROM auth.users WHERE id = b.owner_id),
  (SELECT (user_metadata->>'full_name')::text FROM auth.users WHERE id = b.owner_id),
  (SELECT email FROM auth.users WHERE id = b.owner_id)
)
WHERE owner_name IS NULL;

