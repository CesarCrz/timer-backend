-- Actualizar features para los planes de suscripción
-- Plan Básico
UPDATE public.subscription_tiers
SET features = '[
  "Hasta 2 sucursales",
  "Hasta 15 empleados",
  "Control de asistencia por GPS",
  "Reportes de nómina básicos",
  "Exportación a PDF y Excel",
  "Soporte por email",
  "Cálculo automático de horas trabajadas",
  "Detección de llegadas tarde",
  "Cálculo de tiempo extra"
]'::jsonb
WHERE name = 'Básico';

-- Plan Profesional
UPDATE public.subscription_tiers
SET features = '[
  "Hasta 5 sucursales",
  "Hasta 50 empleados",
  "Control de asistencia por GPS",
  "Reportes de nómina avanzados",
  "Exportación a PDF y Excel",
  "Envío de reportes por email",
  "Soporte prioritario",
  "Cálculo automático de horas trabajadas",
  "Detección de llegadas tarde",
  "Cálculo de tiempo extra",
  "Historial completo de asistencia",
  "Múltiples zonas horarias"
]'::jsonb
WHERE name = 'Profesional';

-- Plan Empresarial
UPDATE public.subscription_tiers
SET features = '[
  "Sucursales ilimitadas",
  "Hasta 200 empleados",
  "Control de asistencia por GPS",
  "Reportes de nómina completos",
  "Exportación a PDF y Excel",
  "Envío de reportes por email",
  "Soporte 24/7",
  "Cálculo automático de horas trabajadas",
  "Detección de llegadas tarde",
  "Cálculo de tiempo extra",
  "Historial completo de asistencia",
  "Múltiples zonas horarias",
  "API personalizada",
  "Integraciones personalizadas",
  "Plan a medida disponible"
]'::jsonb
WHERE name = 'Empresarial';

