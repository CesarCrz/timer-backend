type TemplateName = 'report-ready' | 'invitation' | 'payment-failed' | 'generic';

type TemplateData = Record<string, any>;

function baseLayout(content: string, title = 'Timer') {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{background:#f6f9fc;margin:0;padding:24px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;color:#0f172a}
    .card{max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.05);overflow:hidden;border:1px solid #e5e7eb}
    .header{padding:20px 24px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px}
    .brand{font-weight:700;font-size:16px;color:#111827}
    .content{padding:24px}
    .btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600}
    .muted{color:#6b7280;font-size:12px;margin-top:16px}
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="${process.env.FRONTEND_URL || 'https://timer.app'}/placeholder-logo.svg" width="24" height="24" alt="Timer" />
      <div class="brand">Timer</div>
    </div>
    <div class="content">${content}</div>
  </div>
</body>
</html>`;
}

function reportReadyTemplate(data: { reportUrl: string; expiresAt?: string }) {
  const expires = data.expiresAt ? `<p class="muted">Este enlace expira: ${new Date(data.expiresAt).toLocaleString('es-MX')}</p>` : '';
  const content = `
    <h2 style="margin:0 0 12px 0">Tu reporte está listo</h2>
    <p style="margin:0 0 16px 0;color:#374151">Generamos tu reporte de asistencia. Puedes descargarlo con el siguiente botón:</p>
    <p style="margin:0 0 16px 0">
      <a class="btn" href="${data.reportUrl}" target="_blank" rel="noopener noreferrer">Descargar reporte</a>
    </p>
    ${expires}
  `;
  return baseLayout(content, 'Reporte listo | Timer');
}

function genericTemplate(data: { title?: string; bodyHtml: string }) {
  return baseLayout(data.bodyHtml, data.title || 'Timer');
}

export function renderTemplate(name: TemplateName, data: TemplateData): { subject: string; html: string } {
  switch (name) {
    case 'report-ready': {
      const html = reportReadyTemplate({ reportUrl: data.reportUrl, expiresAt: data.expiresAt });
      return { subject: 'Tu reporte está listo', html };
    }
    case 'invitation': {
      const content = `
        <h2 style="margin:0 0 12px 0">Has sido invitado a Timer</h2>
        <p style="margin:0 0 16px 0;color:#374151">Hola ${data.fullName || ''}, fuiste invitado a *${data.businessName || 'tu empresa'}*.</p>
        <p><a class="btn" href="${data.confirmUrl}" target="_blank" rel="noopener">Confirmar invitación</a></p>
        <p class="muted">Este enlace expira en 24 horas.</p>
      `;
      return { subject: 'Invitación a Timer', html: baseLayout(content, 'Invitación | Timer') };
    }
    case 'payment-failed': {
      const content = `
        <h2 style="margin:0 0 12px 0">Pago no procesado</h2>
        <p style="margin:0 0 16px 0;color:#374151">Hubo un problema con tu último pago. Por favor actualiza tu método de pago para evitar interrupciones.</p>
      `;
      return { subject: 'Problema con tu pago', html: baseLayout(content, 'Pago no procesado | Timer') };
    }
    case 'generic':
    default: {
      const html = genericTemplate({ title: data.title, bodyHtml: data.bodyHtml });
      return { subject: data.title || 'Timer', html };
    }
  }
}


