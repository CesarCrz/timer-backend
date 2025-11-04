# Environment Variables (backend)

Set these in `.env` (or your VPS process manager). Defaults are safe for local dev where indicated.

## Core URLs
- BACKEND_API_URL: default http://localhost:3001
- FRONTEND_URL: default http://localhost:3000
- BUILDERBOT_API_URL: default http://localhost:3008

## Secrets
- BUILDERBOT_API_SECRET: required (shared secret between backend and BuilderBot)
- CRON_SECRET: required (used by VPS cron HTTP calls)

## Supabase
- SUPABASE_URL: required (service role client)
- SUPABASE_SERVICE_ROLE_KEY: required (NEVER expose to frontend)
- NEXT_PUBLIC_SUPABASE_URL: required (for SSR auth)
- NEXT_PUBLIC_SUPABASE_ANON_KEY: required

## Stripe
- STRIPE_SECRET_KEY: required
- STRIPE_WEBHOOK_SECRET: required (for webhook signature verification)

## Resend
- RESEND_API_KEY: required to send emails

## Node
- NODE_ENV: development | production







