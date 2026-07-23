const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://concesiones.clubleon.mx",
] as const;

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Une defaults + env + store. El env NO reemplaza los defaults: en Cloud Run
 * a menudo queda un CORS_ALLOWED_ORIGINS viejo (solo localhost) que, si
 * reemplazara, bloquearía el front de producción.
 */
export function getAllowedCorsOriginsWithStore(): string[] {
  const fromEnv = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const storeOrigin = process.env.STORE_PUBLIC_BASE_URL?.trim();

  return [
    ...new Set([
      ...DEFAULT_CORS_ORIGINS,
      ...fromEnv,
      ...(storeOrigin ? [storeOrigin] : []),
    ]),
  ];
}
