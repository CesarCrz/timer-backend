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

  // Manejar errores de validación de Zod
  if (error?.name === 'ZodError' || error?.issues) {
    const issues = error.issues || [];
    const messages = issues.map((issue: any) => {
      const field = issue.path.join('.');
      let message = issue.message;
      
      // Mensajes más amigables en español
      if (issue.code === 'too_small') {
        if (issue.type === 'string') {
          message = `${field === 'name' ? 'El nombre' : `El campo ${field}`} debe tener al menos ${issue.minimum} caracteres`;
        } else if (issue.type === 'number') {
          message = `${field === 'name' ? 'El valor' : `El campo ${field}`} debe ser mayor o igual a ${issue.minimum}`;
        }
      } else if (issue.code === 'too_big') {
        if (issue.type === 'string') {
          message = `${field === 'name' ? 'El nombre' : `El campo ${field}`} no puede tener más de ${issue.maximum} caracteres`;
        } else if (issue.type === 'number') {
          message = `${field === 'name' ? 'El valor' : `El campo ${field}`} debe ser menor o igual a ${issue.maximum}`;
        }
      } else if (issue.code === 'invalid_type') {
        message = `${field === 'name' ? 'El nombre' : `El campo ${field}`} tiene un tipo de dato inválido`;
      } else if (issue.code === 'invalid_string') {
        if (issue.validation === 'email') {
          message = 'El correo electrónico no es válido';
        } else if (issue.validation === 'url') {
          message = 'La URL no es válida';
        } else if (issue.validation === 'regex') {
          message = `${field === 'name' ? 'El formato' : `El formato del campo ${field}`} no es válido`;
        }
      }
      
      return message;
    });
    
    const mainMessage = messages.length === 1 
      ? messages[0] 
      : `Hay ${messages.length} errores de validación: ${messages.join('; ')}`;
    
    return Response.json({ 
      error: mainMessage,
      code: 'VALIDATION_ERROR',
      details: issues.map((issue: any) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }))
    }, { status: 400 });
  }

  if (error instanceof ValidationError) {
    return Response.json({ 
      error: error.message, 
      code: 'VALIDATION_ERROR',
      details: error.details 
    }, { status: 400 });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ 
      error: error.message,
      code: 'UNAUTHORIZED'
    }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return Response.json({ 
      error: error.message,
      code: 'FORBIDDEN'
    }, { status: 403 });
  }
  if (error instanceof NotFoundError) {
    return Response.json({ 
      error: error.message,
      code: 'NOT_FOUND'
    }, { status: 404 });
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
  
  // Error genérico del servidor
  return Response.json({ 
    error: error?.message || 'Error interno del servidor',
    code: 'INTERNAL_ERROR'
  }, { status: 500 });
}







