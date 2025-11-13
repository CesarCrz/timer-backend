import nodemailer from 'nodemailer';

type Attachment = { 
  filename: string; 
  content: Buffer | string; 
  contentType?: string;
};

/**
 * Cliente de email usando Nodemailer para enviar correos con adjuntos
 * Usa Gmail SMTP o configuración personalizada
 */
export async function sendEmailWithAttachment(params: { 
  to: string; 
  subject: string; 
  html: string; 
  from?: string; 
  attachments?: Attachment[] 
}) {
  const from = params.from || process.env.SMTP_FROM || 'no-reply@ceats.app';
  
  // Configurar transporter de Nodemailer
  // Si hay variables de entorno de SMTP, usarlas; si no, usar Gmail
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;
  
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: smtpPort,
    secure: smtpSecure, // true para 465, false para otros puertos
    auth: {
      user: process.env.SMTP_USER || process.env.GMAIL_USER,
      pass: process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD,
    },
    tls: {
      // No rechazar certificados no autorizados (útil para desarrollo)
      rejectUnauthorized: false,
    },
    connectionTimeout: 10000, // 10 segundos
    greetingTimeout: 10000, // 10 segundos
    socketTimeout: 10000, // 10 segundos
    debug: process.env.NODE_ENV === 'development', // Activar debug en desarrollo
  });

  try {
    console.log('📧 [NODEMAILER] Enviando correo con adjuntos:', {
      from,
      to: params.to,
      subject: params.subject,
      hasAttachments: !!params.attachments?.length,
      attachmentCount: params.attachments?.length || 0,
    });

    // Preparar adjuntos para Nodemailer
    const attachments = params.attachments?.map(a => ({
      filename: a.filename,
      content: a.content, // Nodemailer acepta Buffer directamente
      contentType: a.contentType,
    })) || [];

    const mailOptions = {
      from,
      to: params.to.split(',').map(email => email.trim()), // Nodemailer acepta array
      subject: params.subject,
      html: params.html,
      attachments,
    };

    const result = await transporter.sendMail(mailOptions);
    
    console.log('✅ [NODEMAILER] Correo enviado exitosamente:', {
      messageId: result.messageId,
      response: result.response,
      to: params.to,
    });
    
    return result;
  } catch (error: any) {
    console.error('❌ [NODEMAILER] Error enviando correo:', {
      error: error.message,
      stack: error.stack,
      code: error.code,
      command: error.command,
      response: error.response,
      to: params.to,
      subject: params.subject,
    });
    throw error;
  }
}

