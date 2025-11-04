import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail(params: { to: string; subject: string; html: string; from?: string }) {
  const from = params.from || 'no-reply@timer.app';
  return resend.emails.send({ from, to: params.to, subject: params.subject, html: params.html });
}



