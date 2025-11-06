export class ValidationError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class PlanLimitError extends Error {
  constructor(public resource: string, public current: number, public max: number) {
    super(`Plan limit exceeded for ${resource}`);
    this.name = 'PlanLimitError';
  }
}

export function handleApiError(error: any): Response {
  console.error('API Error:', error);

  // Manejar error de suscripción no encontrada
  if (error?.code === 'NO_SUBSCRIPTION' || error?.message?.includes('No active subscription found')) {
    return Response.json(
      { 
        error: 'No active subscription found',
        code: 'NO_SUBSCRIPTION',
        message: 'No tienes una suscripción activa. Por favor, selecciona un plan para continuar.'
      },
      { status: 402 } // Payment Required
    );
  }

  if (error instanceof ValidationError) {
    return Response.json({ error: error.message, details: error.details }, { status: 400 });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof NotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof PlanLimitError) {
    return Response.json(
      { 
        error: error.message, 
        code: 'PLAN_LIMIT_EXCEEDED',
        current: error.current, 
        max: error.max 
      },
      { status: 403 }
    );
  }
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}







