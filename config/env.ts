const dev = process.env.NODE_ENV !== 'production';

export const env = {
  BACKEND_API_URL: process.env.BACKEND_API_URL || 'http://localhost:3001',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  BUILDERBOT_API_URL: process.env.BUILDERBOT_API_URL || 'http://localhost:3008',
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:3001,http://localhost:3008,https://timer.app,https://api.timer.app,https://wa.timer.app')
    .split(',')
    .map(s => s.trim()),

  BUILDERBOT_API_SECRET: process.env.BUILDERBOT_API_SECRET || (dev ? 'dev-secret' : ''),
  CRON_SECRET: process.env.CRON_SECRET || (dev ? 'dev-cron' : ''),

  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
};

export function assertProdEnv() {
  if (dev) return;
  const required = [
    'BACKEND_API_URL',
    'FRONTEND_URL',
    'BUILDERBOT_API_URL',
    'BUILDERBOT_API_SECRET',
    'CRON_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
  ] as const;

  const missing = required.filter((k) => !(env as any)[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars in production: ${missing.join(', ')}`);
  }
}


