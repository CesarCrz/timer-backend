# Resend Setup

1) Create project and get `RESEND_API_KEY`.
2) Add a verified domain (e.g., mail.timer.app) and follow DNS (SPF/DKIM) instructions.
3) Choose default sender (e.g., `no-reply@timer.app`).
4) Enable click/open tracking if desired.
5) Set `RESEND_API_KEY` in backend `.env`.

## Templates and Events
- report-ready: used by `/api/reports/generate-and-email` (subject: “Tu reporte está listo”).
- invitation (planned): used by employee invitation (WhatsApp primary; email fallback).
- payment-failed (planned): used by Stripe `invoice.payment_failed` webhook.

You can customize HTML in `lib/emails/templates/index.ts`.







