import { UserRole } from "../models";

/** Roles persistidos en usuariosApp (app-oficial-leon). */
export const CONCESION_ROLES = {
  SUPERADMIN: "CONCESION_SUPERADMIN",
  ADMIN: "CONCESION_ADMIN",
  VENDEDOR: "CONCESION_VENDEDOR",
} as const;

export type ConcesionRole =
  (typeof CONCESION_ROLES)[keyof typeof CONCESION_ROLES];

const CONCESION_ROLE_SET = new Set<string>(Object.values(CONCESION_ROLES));

/** Roles internos del POS (RBAC existente). */
export const INTERNAL_TO_CONCESION: Record<UserRole, ConcesionRole> = {
  [UserRole.SUPERADMIN]: CONCESION_ROLES.SUPERADMIN,
  [UserRole.ADMIN]: CONCESION_ROLES.ADMIN,
  [UserRole.VENDEDOR]: CONCESION_ROLES.VENDEDOR,
};

const CONCESION_TO_INTERNAL: Record<string, UserRole> = {
  [CONCESION_ROLES.SUPERADMIN]: UserRole.SUPERADMIN,
  [CONCESION_ROLES.ADMIN]: UserRole.ADMIN,
  [CONCESION_ROLES.VENDEDOR]: UserRole.VENDEDOR,
  // Alias legados del POS
  SUPERADMIN: UserRole.SUPERADMIN,
  ADMIN: UserRole.ADMIN,
  VENDEDOR: UserRole.VENDEDOR,
  EMPLEADO: UserRole.VENDEDOR,
  // Typo histórico (falta la "N" en CONCESION)
  CONCESIO_VENDEDOR: UserRole.VENDEDOR,
  CONCESIO_ADMIN: UserRole.ADMIN,
  CONCESIO_SUPERADMIN: UserRole.SUPERADMIN,
};

/** Variantes de rol (typos, legados) que se normalizan al rol canónico CONCESION_*. */
const CONCESION_ROLE_ALIASES: Record<string, ConcesionRole> = {
  CONCESIO_VENDEDOR: CONCESION_ROLES.VENDEDOR,
  CONCESIO_ADMIN: CONCESION_ROLES.ADMIN,
  CONCESIO_SUPERADMIN: CONCESION_ROLES.SUPERADMIN,
};

export const isConcesionRole = (rol?: string | null): boolean => {
  if (!rol) return false;
  const upper = String(rol).toUpperCase();
  return CONCESION_ROLE_SET.has(upper) || upper in CONCESION_ROLE_ALIASES;
};

/**
 * Normaliza cualquier rol (CONCESION_* o legado) al rol interno del POS.
 */
export const toInternalRole = (rol?: string | null): UserRole | undefined => {
  if (!rol) return undefined;
  const upper = String(rol).toUpperCase();
  return CONCESION_TO_INTERNAL[upper];
};

/**
 * Convierte un rol entrante (UI/API) al rol persistido en usuariosApp.
 */
export const toConcesionRole = (rol: string): ConcesionRole => {
  const internal = toInternalRole(rol);
  if (!internal) {
    throw new Error(`Rol no válido para concesión: ${rol}`);
  }
  return INTERNAL_TO_CONCESION[internal];
};

export const isPosEligibleUser = (profile: {
  from_concesion?: boolean;
  activo?: boolean;
  rol?: string;
}): boolean => {
  if (profile.activo === false) return false;
  if (profile.from_concesion !== true) return false;
  return isConcesionRole(profile.rol);
};
