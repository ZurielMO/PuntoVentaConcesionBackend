import { Response } from "express";
import { ApiError } from "./api-error";

export type PublicFieldError = {
  field: string;
  message: string;
  code?: string;
};

export type PublicErrorBody = {
  success: false;
  code: string;
  message: string;
  fieldErrors?: PublicFieldError[];
  retryable?: boolean;
  requestId?: string;
};

export type PublicErrorOptions = {
  fallbackMessage?: string;
  fallbackCode?: string;
  fieldErrors?: PublicFieldError[];
  retryable?: boolean;
  logLabel?: string;
};

const DEFAULT_INTERNAL_MESSAGE =
  "Ocurrió un error inesperado. Intenta nuevamente en unos momentos.";
const DEFAULT_INTERNAL_CODE = "INTERNAL_ERROR";

// Patrones que indican mensajes técnicos que NO deben exponerse al cliente.
const TECHNICAL_MESSAGE_PATTERNS: RegExp[] = [
  /\bauth\/[a-z0-9-]+\b/i,
  /\bfirestore\b/i,
  /\bfirebase\b/i,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bstack trace\b/i,
  /\bat\s+\S+\s+\(/i,
  /JWT_SECRET/i,
  /requires an index/i,
  /permission[- ]denied/i,
  /service account/i,
  /secret key/i,
  /process\.env/i,
];

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

export const isTechnicalMessage = (message: string): boolean => {
  const normalized = message.trim();
  if (!normalized) {
    return true;
  }

  return TECHNICAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
};

export const sanitizePublicMessage = (
  message: string | undefined,
  fallback = DEFAULT_INTERNAL_MESSAGE,
): string => {
  if (!message || !message.trim()) {
    return fallback;
  }

  if (isTechnicalMessage(message)) {
    return fallback;
  }

  return message.trim();
};

export const isRetryableStatus = (statusCode: number): boolean =>
  RETRYABLE_STATUS_CODES.has(statusCode);

const resolveOperationalError = (
  error: unknown,
  options: PublicErrorOptions,
): {
  statusCode: number;
  code: string;
  message: string;
  fieldErrors?: PublicFieldError[];
  retryable: boolean;
} | null => {
  if (error instanceof ApiError && error.isOperational) {
    return {
      statusCode: error.statusCode,
      code: options.fallbackCode ?? error.code ?? `HTTP_${error.statusCode}`,
      message: sanitizePublicMessage(error.message, options.fallbackMessage),
      fieldErrors: options.fieldErrors,
      retryable: options.retryable ?? isRetryableStatus(error.statusCode),
    };
  }

  return null;
};

export const buildPublicErrorBody = (
  error: unknown,
  requestId?: string,
  options: PublicErrorOptions = {},
): { statusCode: number; body: PublicErrorBody } => {
  const fallbackMessage = options.fallbackMessage ?? DEFAULT_INTERNAL_MESSAGE;
  const fallbackCode = options.fallbackCode ?? DEFAULT_INTERNAL_CODE;

  const operational = resolveOperationalError(error, options);
  if (operational) {
    return {
      statusCode: operational.statusCode,
      body: {
        success: false,
        code: operational.code,
        message: operational.message,
        ...(operational.fieldErrors?.length
          ? { fieldErrors: operational.fieldErrors }
          : {}),
        retryable: operational.retryable,
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  const statusCode = 500;

  return {
    statusCode,
    body: {
      success: false,
      code: fallbackCode,
      message: fallbackMessage,
      retryable: options.retryable ?? true,
      ...(requestId ? { requestId } : {}),
    },
  };
};

export const logSafeError = (
  label: string,
  error: unknown,
  requestId?: string,
): void => {
  const payload: Record<string, unknown> = { label };

  if (requestId) {
    payload.requestId = requestId;
  }

  if (error instanceof Error) {
    payload.message = error.message;
    payload.stack = error.stack;
    if (error instanceof ApiError) {
      payload.statusCode = error.statusCode;
      payload.isOperational = error.isOperational;
    }
  } else {
    payload.error = error;
  }

  console.error("[public-error]", payload);
};

export const sendPublicError = (
  res: Response,
  error: unknown,
  requestId?: string,
  options: PublicErrorOptions = {},
): Response => {
  logSafeError(options.logLabel ?? "unhandled_error", error, requestId);

  const { statusCode, body } = buildPublicErrorBody(error, requestId, options);
  return res.status(statusCode).json(body);
};
