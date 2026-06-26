export type FieldError = {
  field: string;
  message: string;
  code?: string;
};

/**
 * Base API error class. Errores operativos esperados de la aplicación.
 */
export class ApiError extends Error {
  statusCode: number;
  isOperational: boolean;
  code?: string;
  fieldErrors?: FieldError[];

  constructor(
    statusCode: number,
    message: string,
    isOperational = true,
    code?: string,
    fieldErrors?: FieldError[],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.fieldErrors = fieldErrors;

    Error.captureStackTrace(this, this.constructor);
  }
}
