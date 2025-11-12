-- Corregir el trigger de owner_name para que no falle al crear businesses
-- Este script reemplaza el trigger anterior con uno más robusto

-- Primero, eliminar el trigger y función existentes
DROP TRIGGER IF EXISTS trigger_update_business_owner_name ON public.businesses;
DROP FUNCTION IF EXISTS public.update_business_owner_name();

-- Crear función mejorada con manejo de errores y SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.update_business_owner_name()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo actualizar si owner_name no fue proporcionado explícitamente
  IF NEW.owner_name IS NULL THEN
    BEGIN
      -- Intentar obtener el full_name del usuario desde auth.users
      -- Usar SECURITY DEFINER para tener permisos de lectura en auth.users
      SELECT COALESCE(
        (raw_user_meta_data->>'full_name')::text,
        (user_metadata->>'full_name')::text,
        email
      ) INTO NEW.owner_name
      FROM auth.users
      WHERE id = NEW.owner_id;
    EXCEPTION WHEN OTHERS THEN
      -- Si falla por cualquier razón, dejar owner_name como NULL
      -- Esto evita que el INSERT falle
      NEW.owner_name := NULL;
    END;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Crear trigger que solo se ejecuta si owner_name es NULL
CREATE TRIGGER trigger_update_business_owner_name
  BEFORE INSERT OR UPDATE OF owner_id ON public.businesses
  FOR EACH ROW
  WHEN (NEW.owner_name IS NULL)
  EXECUTE FUNCTION public.update_business_owner_name();

-- Actualizar owner_name para businesses existentes que no lo tengan
UPDATE public.businesses b
SET owner_name = COALESCE(
  (SELECT (raw_user_meta_data->>'full_name')::text FROM auth.users WHERE id = b.owner_id),
  (SELECT (user_metadata->>'full_name')::text FROM auth.users WHERE id = b.owner_id),
  (SELECT email FROM auth.users WHERE id = b.owner_id)
)
WHERE owner_name IS NULL;

