# Nodemailer Setup para Reportes con Adjuntos

Nodemailer se usa para enviar correos con adjuntos (reportes PDF/Excel). Resend se mantiene solo para correos informativos (login, suscripciones).

## Configuración

### Opción 1: Gmail (Recomendado para desarrollo)

1. Habilitar "Contraseñas de aplicaciones" en tu cuenta de Google:
   - Ir a https://myaccount.google.com/apppasswords
   - Generar una contraseña de aplicación para "Correo"

2. Agregar variables de entorno en `.env`:
```env
GMAIL_USER=tu-email@gmail.com
GMAIL_APP_PASSWORD=tu-contraseña-de-aplicación
SMTP_FROM=tu-email@gmail.com
```

### Opción 2: SMTP Personalizado

Si prefieres usar otro proveedor SMTP (SendGrid, Mailgun, etc.):

```env
SMTP_HOST=smtp.tu-proveedor.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-usuario
SMTP_PASS=tu-contraseña
SMTP_FROM=no-reply@timer.app
```

## Variables de Entorno

- `GMAIL_USER`: Email de Gmail (si usas Gmail)
- `GMAIL_APP_PASSWORD`: Contraseña de aplicación de Gmail (si usas Gmail)
- `SMTP_HOST`: Host del servidor SMTP (opcional, default: smtp.gmail.com)
- `SMTP_PORT`: Puerto SMTP (opcional, default: 587)
- `SMTP_SECURE`: true para puerto 465, false para otros (opcional, default: false)
- `SMTP_USER`: Usuario SMTP (opcional, usa GMAIL_USER si no se proporciona)
- `SMTP_PASS`: Contraseña SMTP (opcional, usa GMAIL_APP_PASSWORD si no se proporciona)
- `SMTP_FROM`: Email remitente (opcional, default: no-reply@timer.app)

## Notas

- Nodemailer se usa automáticamente para correos con adjuntos (reportes)
- Resend se mantiene para correos informativos sin adjuntos
- Los logs mostrarán `[NODEMAILER]` para correos con adjuntos y `[EMAIL]` para correos informativos

