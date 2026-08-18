const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://foodmarket.clubleon.mx",
] as const;

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function readConfiguredOrigins(): string[] {
  return [
    ...new Set([
      ...DEFAULT_CORS_ORIGINS,
      ...parseOrigins(process.env.CORS_ALLOWED_ORIGINS),
    ]),
  ];
}

export function getAllowedCorsOriginsWithStore(): string[] {
  const storeOrigin = process.env.STORE_PUBLIC_BASE_URL?.trim();

  return [
    ...new Set([
      ...readConfiguredOrigins(),
      ...(storeOrigin ? [storeOrigin] : []),
    ]),
  ];
}
