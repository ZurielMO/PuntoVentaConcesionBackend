const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
] as const;

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function readConfiguredOrigins(): string[] {
  const fromEnv = parseOrigins(process.env.CORS_ALLOWED_ORIGINS);
  if (fromEnv.length > 0) {
    return fromEnv;
  }

  return [...DEFAULT_CORS_ORIGINS];
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
