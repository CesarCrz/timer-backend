import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY);

type Attachment = { 
  filename: string; 
  content: Buffer | string; 
  contentType?: string;
  encoding?: string;
};

export async function sendEmail(params: { to: string; subject: string; html: string; from?: string; attachments?: Attachment[] }) {
  const from = params.from || 'no-reply@ceats.app';
  
  try {
    // Resend espera attachments como array de objetos con content como string (base64)
    const attachments = params.attachments?.map(a => {
      // Si el content es Buffer, convertirlo a base64
      if (Buffer.isBuffer(a.content)) {
        return {
          filename: a.filename,
          content: a.content.toString('base64'),
        };
      }
      // Si ya es string (base64), usarlo directamente
      return {
        filename: a.filename,
        content: a.content,
      };
    });
    
    console.log('📧 [EMAIL] Enviando correo:', {
      from,
      to: params.to,
      subject: params.subject,
      hasAttachments: !!attachments?.length,
      attachmentCount: attachments?.length || 0,
    });
    
    const result = await resend.emails.send({
      from,
      to: params.to.split(',').map(email => email.trim()), // Resend acepta array de emails
      subject: params.subject,
      html: params.html,
      attachments,
    });
    
    // Verificar si hay error en la respuesta
    if (result.error) {
      console.error('❌ [EMAIL] Resend retornó un error:', {
        error: result.error,
        message: result.error.message,
        name: result.error.name,
      });
      throw new Error(result.error.message || 'Error enviando correo con Resend');
    }
    
    console.log('✅ [EMAIL] Correo enviado exitosamente:', {
      id: result.data?.id,
      to: params.to,
    });
    
    return result;
  } catch (error: any) {
    console.error('❌ [EMAIL] Error enviando correo:', {
      error: error.message,
      stack: error.stack,
      response: error.response?.data,
      status: error.response?.status,
      to: params.to,
      subject: params.subject,
    });
    throw error;
  }
}







