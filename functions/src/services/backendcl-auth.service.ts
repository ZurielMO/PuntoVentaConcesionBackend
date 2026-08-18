import axios from "axios";
import jwt from "jsonwebtoken";
import { ApiError } from "../utils/api-error";

const DEFAULT_BACKENDCL_BASE_URL =
  "https://us-central1-e-comerce-leon.cloudfunctions.net/api";

/** Renovar el JWT antes de que expire (authMiddleware rechaza tokens vencidos). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let tokenPromise: Promise<string> | null = null;

/**
 * Base URL de BackendCL (sin slash final).
 *
 * Producción: `https://us-central1-e-comerce-leon.cloudfunctions.net/api`
 * Local:      `http://127.0.0.1:3001` (BackendCL monta rutas bajo `/api`)
 */
export const getBackendClBaseUrl = (): string =>
  (process.env.BACKENDCL_API_BASE_URL || DEFAULT_BACKENDCL_BASE_URL).replace(
    /\/+$/,
    "",
  );

/**
 * Une base + path de BackendCL sin duplicar el segmento `/api`.
 *
 * - base `.../api` + `/api/usuarios/x` → `.../api/usuarios/x`
 * - base `http://127.0.0.1:3001` + `/api/usuarios/x` → `http://127.0.0.1:3001/api/usuarios/x`
 */
export const buildBackendClApiUrl = (path: string): string => {
  const base = getBackendClBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (base.endsWith("/api") && normalizedPath === "/api") {
    return base;
  }
  if (base.endsWith("/api") && normalizedPath.startsWith("/api/")) {
    return `${base}${normalizedPath.slice("/api".length)}`;
  }
  return `${base}${normalizedPath}`;
};

const getStaticBearerToken = (): string | undefined => {
  const token = process.env.BACKENDCL_BEARER_TOKEN?.trim();
  return token || undefined;
};

const decodeTokenExpiryMs = (token: string): number => {
  const decoded = jwt.decode(token);
  if (
    decoded &&
    typeof decoded === "object" &&
    "exp" in decoded &&
    typeof decoded.exp === "number"
  ) {
    return decoded.exp * 1000;
  }
  return Date.now() + DEFAULT_TOKEN_TTL_MS;
};

const isCachedTokenFresh = (cache: TokenCache): boolean =>
  Date.now() < cache.expiresAt - REFRESH_BUFFER_MS;

const extractSessionToken = (payload: unknown): string | undefined => {
  const data = payload as {
    token?: string;
    bearerToken?: string;
    data?: { token?: string };
  };

  return data.token ?? data.bearerToken ?? data.data?.token;
};

const loginToBackendCl = async (): Promise<TokenCache> => {
  const email = process.env.BACKENDCL_AUTH_EMAIL?.trim();
  const password = process.env.BACKENDCL_AUTH_PASSWORD;

  if (!email || !password) {
    throw new ApiError(
      503,
      "Integración de puntos no configurada (BACKENDCL_AUTH_EMAIL y BACKENDCL_AUTH_PASSWORD, o BACKENDCL_BEARER_TOKEN)",
      true,
      "LOYALTY_NOT_CONFIGURED",
    );
  }

  const url = buildBackendClApiUrl("/api/auth/register-or-login");

  let response;
  try {
    response = await axios.post(
      url,
      {
        email,
        password,
        nombre: process.env.BACKENDCL_AUTH_NOMBRE?.trim() || "POS Integration",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      },
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        throw new ApiError(
          503,
          "Credenciales de BackendCL inválidas",
          true,
          "BACKENDCL_AUTH_FAILED",
        );
      }
    }
    throw new ApiError(
      502,
      "No se pudo autenticar con BackendCL",
      true,
      "BACKENDCL_UNAVAILABLE",
    );
  }

  const sessionToken = extractSessionToken(response.data);
  if (!sessionToken) {
    throw new ApiError(
      502,
      "BackendCL no devolvió token de sesión",
      true,
      "BACKENDCL_UNAVAILABLE",
    );
  }

  return {
    token: sessionToken,
    expiresAt: decodeTokenExpiryMs(sessionToken),
  };
};

const refreshBackendClToken = async (
  currentToken: string,
): Promise<TokenCache> => {
  const url = buildBackendClApiUrl("/api/auth/refresh");

  const response = await axios.post(
    url,
    {},
    {
      headers: {
        Authorization: `Bearer ${currentToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 15000,
    },
  );

  const sessionToken = extractSessionToken(response.data);
  if (!sessionToken) {
    throw new ApiError(
      502,
      "BackendCL no devolvió token al renovar sesión",
      true,
      "BACKENDCL_UNAVAILABLE",
    );
  }

  return {
    token: sessionToken,
    expiresAt: decodeTokenExpiryMs(sessionToken),
  };
};

const resolveDynamicToken = async (): Promise<string> => {
  if (tokenCache && isCachedTokenFresh(tokenCache)) {
    return tokenCache.token;
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    try {
      tokenCache = await refreshBackendClToken(tokenCache.token);
      return tokenCache.token;
    } catch {
      tokenCache = null;
    }
  }

  tokenCache = await loginToBackendCl();
  return tokenCache.token;
};

/**
 * Obtiene un JWT de sesión de BackendCL (Club León).
 * Prioridad: BACKENDCL_BEARER_TOKEN estático > login automático con email/password.
 */
export const getBackendClBearerToken = async (): Promise<string> => {
  const staticToken = getStaticBearerToken();
  if (staticToken) {
    return staticToken;
  }

  if (!tokenPromise) {
    tokenPromise = resolveDynamicToken().finally(() => {
      tokenPromise = null;
    });
  }

  return tokenPromise;
};

/** Limpia caché en memoria (p. ej. tras 401 para forzar re-login). */
export const invalidateBackendClAuthCache = (): void => {
  tokenCache = null;
  tokenPromise = null;
};

/** Solo para tests: alias de invalidateBackendClAuthCache. */
export const resetBackendClAuthCacheForTests = invalidateBackendClAuthCache;
