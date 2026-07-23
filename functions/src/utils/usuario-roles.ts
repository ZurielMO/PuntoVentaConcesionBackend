/** Helpers de roles para usuariosApp (app-oficial-leon). */

export const ROL_CLIENTE = "CLIENTE";
export const ROL_TRABAJADOR_CLUBLEON = "TRABAJADOR_CLUBLEON";

const FORBIDDEN_TRABAJADOR_CLUB_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "EMPLEADO",
  "EMPLEADO_CLUB",
  "CONCESION_SUPERADMIN",
  "CONCESION_ADMIN",
  "CONCESION_ADMIN_CERVECERIA",
  "CONCESION_VENDEDOR",
];

type UsuarioRolesInput = {
  rol?: string;
  roles?: string[];
  activo?: boolean;
};

export const getEffectiveRoles = (usuario: UsuarioRolesInput): string[] => {
  if (usuario.roles && usuario.roles.length > 0) {
    return [...usuario.roles];
  }
  if (usuario.rol) {
    return [usuario.rol];
  }
  return [];
};

export const hasRole = (usuario: UsuarioRolesInput, role: string): boolean =>
  getEffectiveRoles(usuario).includes(role);

export const isTrabajadorClub = (usuario: UsuarioRolesInput): boolean =>
  hasRole(usuario, ROL_TRABAJADOR_CLUBLEON);

export const canAddAsTrabajadorClub = (
  usuario: UsuarioRolesInput,
): { ok: true } | { ok: false; code: string; message: string } => {
  if (usuario.activo === false) {
    return {
      ok: false,
      code: "INACTIVE_USER",
      message: "La cuenta del usuario está inactiva",
    };
  }

  const roles = getEffectiveRoles(usuario);

  if (isTrabajadorClub(usuario)) {
    return {
      ok: false,
      code: "ALREADY_TRABAJADOR",
      message: "El usuario ya es trabajador del club",
    };
  }

  if (roles.some((r) => FORBIDDEN_TRABAJADOR_CLUB_ROLES.includes(r))) {
    return {
      ok: false,
      code: "FORBIDDEN_ROLE",
      message: "Este usuario no puede agregarse como trabajador del club",
    };
  }

  if (!hasRole(usuario, ROL_CLIENTE)) {
    return {
      ok: false,
      code: "NOT_CLIENTE",
      message: "Solo usuarios con rol CLIENTE pueden agregarse",
    };
  }

  return { ok: true };
};
