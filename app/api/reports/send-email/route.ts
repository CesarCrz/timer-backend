import { z } from 'zod';
import { withCors, preflight } from '@/lib/utils/cors';
import { handleApiError } from '@/lib/utils/errors';
import { getCurrentUser } from '@/lib/utils/auth';
import { sendEmail } from '@/lib/emails/client';
import { renderTemplate } from '@/lib/emails/templates';

const schema = z.object({
  report_url: z.string().url(),
  email: z.string().email().optional(),
});

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('origin');
  return preflight(origin);
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    const user = await getCurrentUser(request);
    const body = await request.json();
    const { report_url, email } = schema.parse(body);

    const to = email || (user.email as string);
    const { subject, html } = renderTemplate('report-ready', { reportUrl: report_url });
    await sendEmail({ to, subject, html });

    return withCors(origin, Response.json({ sent: true }));
  } catch (error) {
    return handleApiError(error);
  }
}



