import { env } from '@/config/env';

const DEFAULT_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
const DEFAULT_HEADERS = 'Content-Type,Authorization';

export function withCors(origin: string | null, res: Response): Response {
  const allowed = isOriginAllowed(origin);
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Methods', DEFAULT_METHODS);
  headers.set('Access-Control-Allow-Headers', DEFAULT_HEADERS);
  headers.set('Vary', 'Origin');
  if (allowed && origin) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(res.body, { status: res.status, headers });
}

export function preflight(origin: string | null): Response {
  const allowed = isOriginAllowed(origin);
  const headers = new Headers();
  headers.set('Access-Control-Allow-Methods', DEFAULT_METHODS);
  headers.set('Access-Control-Allow-Headers', DEFAULT_HEADERS);
  headers.set('Vary', 'Origin');
  if (allowed && origin) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(null, { status: 204, headers });
}

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  // En desarrollo, permitir localhost en cualquier puerto
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && origin.startsWith('http://localhost:')) {
    return true;
  }
  return env.CORS_ALLOWED_ORIGINS.includes(origin);
}







