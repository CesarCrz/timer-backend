import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY);

type Attachment = { filename: string; content: Buffer | string; contentType?: string };

export async function sendEmail(params: { to: string; subject: string; html: string; from?: string; attachments?: Attachment[] }) {
  const from = params.from || 'no-reply@timer.app';
  return resend.emails.send({
    from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    attachments: params.attachments?.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
}







