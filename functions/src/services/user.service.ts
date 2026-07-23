import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import {
  authAppOficial,
  firestoreApp,
  USUARIOS_APP_COLLECTION,
} from "../config/app.firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { UserRole } from "../models";
import { assertCajaBelongsToSucursal } from "./sucursal.service";
import {
  toConcesionRole,
  toInternalRole,
  CONCESION_ROLES,
} from "../utils/concesion-roles";

const usuariosCol = () => firestoreApp.collection(USUARIOS_APP_COLLECTION);
const concessionsCol = () => firestorePos.collection(COLLECTIONS.CONCESIONES);
const sucursalesCol = () => firestorePos.collection(COLLECTIONS.SUCURSALES);

const toData = (
  doc: FirebaseFirestore.DocumentSnapshot,
): Record<string, unknown> & { id: string } => {
  const data = doc.data() ?? {};
  const { password, ...rest } = data as Record<string, unknown>;
  void password;
  const internalRol = toInternalRole(rest.rol as string | undefined);
  const fechaNacimiento =
    (rest.fecha_nacimiento as string | undefined) ??
    (typeof rest.fechaNacimiento === "string"
      ? (rest.fechaNacimiento as string)
      : undefined);

  return {
    id: doc.id,
    ...rest,
    rol: internalRol ?? rest.rol,
    rolOriginal: rest.rol,
    fecha_nacimiento: fechaNacimiento,
    from_concesion: rest.from_concesion === true,
  };
};

const normalizeInternalRole = (rol: string): UserRole => {
  const internal = toInternalRole(rol);
  if (!internal) {
    throw new ApiError(400, `Rol no válido: ${rol}`, true, "INVALID_ROLE");
  }
  return internal;
};

const assertConcessionExists = async (concesionId: string) => {
  const doc = await concessionsCol().doc(concesionId).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
  return doc.data() ?? {};
};

const assertSucursalBelongsToConcession = async (
  sucursalId: string,
  concesionId: string,
) => {
  const doc = await sucursalesCol().doc(sucursalId).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Sucursal no encontrada", true, "NOT_FOUND");
  }
  if (doc.data()?.concesion_id !== concesionId) {
    throw new ApiError(
      400,
      "La sucursal no pertenece a la concesión indicada",
      true,
      "INVALID_SUCURSAL",
    );
  }
  return doc.data() ?? {};
};

/** Una caja solo puede tener un vendedor asignado. */
const assertCajaLibre = async (
  cajaId: string,
  excludeUserId?: string | null,
) => {
  const snap = await usuariosCol()
    .where("from_concesion", "==", true)
    .where("cajaId", "==", cajaId)
    .get();
  const ocupada = snap.docs.find((doc) => {
    const data = doc.data() ?? {};
    if (data.activo === false) return false;
    const rol = normalizeInternalRole(data.rol as string);
    if (rol !== UserRole.VENDEDOR) return false;
    if (
      excludeUserId &&
      (doc.id === excludeUserId || data.uid === excludeUserId)
    ) {
      return false;
    }
    return true;
  });
  if (ocupada) {
    const nombre =
      (ocupada.data()?.nombre as string | undefined) ?? "otro vendedor";
    throw new ApiError(
      400,
      `Esta caja ya está asignada a ${nombre}. Solo 1 vendedor por caja.`,
      true,
      "CAJA_OCCUPIED",
    );
  }
};

const validateUserBusinessRules = async (
  data: {
    rol: string;
    concesionId?: string | null;
    sucursalId?: string | null;
    cajaId?: string | null;
  },
  options?: { excludeUserId?: string | null },
) => {
  const rol = normalizeInternalRole(data.rol);

  if (rol === UserRole.SUPERADMIN) {
    throw new ApiError(
      403,
      "No se pueden crear usuarios SUPERADMIN desde la API",
      true,
      "FORBIDDEN",
    );
  }

  if (!data.concesionId) {
    throw new ApiError(
      400,
      "ADMIN y VENDEDOR requieren concesionId",
      true,
      "MISSING_CONCESSION",
    );
  }

  const concession = await assertConcessionExists(data.concesionId);

  if (rol === UserRole.ADMIN_CERVECERIA) {
    if (concession.tipo !== "CERVECERIA") {
      throw new ApiError(
        400,
        "ADMIN_CERVECERIA solo puede asignarse a concesiones tipo CERVECERIA",
        true,
        "INVALID_CONCESSION_TIPO",
      );
    }
    if (!data.sucursalId) {
      throw new ApiError(
        400,
        "ADMIN_CERVECERIA requiere sucursalId",
        true,
        "MISSING_SUCURSAL",
      );
    }
    const sucursal = await assertSucursalBelongsToConcession(
      data.sucursalId,
      data.concesionId,
    );
    if (sucursal.modo_operacion !== "CONTEO") {
      throw new ApiError(
        400,
        "ADMIN_CERVECERIA solo puede asignarse a sucursales en modo corte por conteo",
        true,
        "INVALID_SUCURSAL_MODO",
      );
    }
  }

  if (rol === UserRole.VENDEDOR) {
    if (!data.sucursalId) {
      throw new ApiError(
        400,
        "Los VENDEDORES requieren sucursalId",
        true,
        "MISSING_SUCURSAL",
      );
    }
    await assertSucursalBelongsToConcession(data.sucursalId, data.concesionId);
    if (data.cajaId) {
      await assertCajaBelongsToSucursal(data.sucursalId, data.cajaId);
      await assertCajaLibre(data.cajaId, options?.excludeUserId);
    }
  }
};

const calcularEdad = (fechaNacimiento?: string): number => {
  if (!fechaNacimiento) return 0;
  const nacimiento = new Date(fechaNacimiento);
  if (Number.isNaN(nacimiento.getTime())) return 0;
  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getFullYear();
  const mes = hoy.getMonth() - nacimiento.getMonth();
  if (mes < 0 || (mes === 0 && hoy.getDate() < nacimiento.getDate())) {
    edad--;
  }
  return edad;
};

export const listVendedoresByConcesion = async (concesionId: string) => {
  const snap = await usuariosCol()
    .where("from_concesion", "==", true)
    .where("concesionId", "==", concesionId)
    .where("rol", "==", CONCESION_ROLES.VENDEDOR)
    .get();
  return snap.docs.map(toData).filter((u) => u.activo !== false);
};

export const listUsers = async (concesionId?: string) => {
  let query: FirebaseFirestore.Query = usuariosCol().where(
    "from_concesion",
    "==",
    true,
  );
  if (concesionId) {
    query = query.where("concesionId", "==", concesionId);
  }
  const snap = await query.get();
  return snap.docs.map(toData);
};

export const getUserById = async (id: string) => {
  const doc = await usuariosCol().doc(id).get();
  if (!doc.exists || doc.data()?.from_concesion !== true) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createUser = async (data: {
  nombre: string;
  fecha_nacimiento?: string;
  email: string;
  password: string;
  rol: string;
  activo?: boolean;
  concesionId?: string | null;
  sucursalId?: string | null;
  cajaId?: string | null;
}) => {
  const internalRole = normalizeInternalRole(data.rol);
  await validateUserBusinessRules({
    rol: internalRole,
    concesionId: data.concesionId,
    sucursalId: data.sucursalId,
    cajaId: data.cajaId,
  });

  const concesionRole = toConcesionRole(internalRole);
  const email = data.email.toLowerCase().trim();

  let authUser;
  try {
    authUser = await authAppOficial.createUser({
      email,
      password: data.password,
      displayName: data.nombre,
      disabled: data.activo === false,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      throw new ApiError(
        409,
        "Ya existe un usuario con ese email",
        true,
        "EMAIL_ALREADY_EXISTS",
      );
    }
    throw error;
  }

  const docData: Record<string, unknown> = {
    uid: authUser.uid,
    provider: "email",
    nombre: data.nombre,
    email,
    genero: "",
    rol: concesionRole,
    activo: data.activo ?? true,
    from_concesion: true,
    concesionId: data.concesionId ?? null,
    puntosActuales: 0,
    nivel: "Bronce",
    perfilCompleto: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (data.fecha_nacimiento) {
    docData.fechaNacimiento = data.fecha_nacimiento;
    docData.fecha_nacimiento = data.fecha_nacimiento;
    docData.edad = calcularEdad(data.fecha_nacimiento);
  } else {
    docData.fechaNacimiento = null;
    docData.fecha_nacimiento = null;
    docData.edad = null;
  }

  const requiereSucursal =
    internalRole === UserRole.VENDEDOR ||
    internalRole === UserRole.ADMIN_CERVECERIA;
  if (requiereSucursal && data.sucursalId) {
    docData.sucursalId = data.sucursalId;
  } else {
    docData.sucursalId = null;
  }
  if (internalRole === UserRole.VENDEDOR && data.cajaId) {
    docData.cajaId = data.cajaId;
  } else {
    docData.cajaId = null;
  }

  try {
    await usuariosCol().doc(authUser.uid).set(docData);
    await authAppOficial.setCustomUserClaims(authUser.uid, {
      admin: false,
      rol: concesionRole,
    });
  } catch (error) {
    try {
      await authAppOficial.deleteUser(authUser.uid);
    } catch {
      // best effort rollback
    }
    throw error;
  }

  const doc = await usuariosCol().doc(authUser.uid).get();
  return toData(doc);
};

export const updateUser = async (
  id: string,
  data: Partial<{
    nombre: string;
    fecha_nacimiento: string;
    email: string;
    password: string;
    rol: string;
    activo: boolean;
    concesionId: string | null;
    sucursalId: string | null;
    cajaId: string | null;
  }>,
) => {
  const ref = usuariosCol().doc(id);
  const doc = await ref.get();
  if (!doc.exists || doc.data()?.from_concesion !== true) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const existing = doc.data() ?? {};
  const mergedRol = data.rol
    ? normalizeInternalRole(data.rol)
    : normalizeInternalRole(existing.rol as string);
  const mergedConcesionId =
    data.concesionId !== undefined
      ? data.concesionId
      : (existing.concesionId as string | null);
  const mergedSucursalId =
    data.sucursalId !== undefined
      ? data.sucursalId
      : (existing.sucursalId as string | null);
  const mergedCajaId =
    data.cajaId !== undefined
      ? data.cajaId
      : (existing.cajaId as string | null);

  if (mergedRol === UserRole.SUPERADMIN) {
    throw new ApiError(
      403,
      "No se puede asignar rol SUPERADMIN",
      true,
      "FORBIDDEN",
    );
  }

  const usesSucursal =
    mergedRol === UserRole.VENDEDOR || mergedRol === UserRole.ADMIN_CERVECERIA;
  const effectiveSucursalId = usesSucursal ? mergedSucursalId : null;
  const effectiveCajaId =
    mergedRol === UserRole.VENDEDOR ? mergedCajaId : null;

  await validateUserBusinessRules({
    rol: mergedRol,
    concesionId: mergedConcesionId,
    sucursalId: effectiveSucursalId,
    cajaId: effectiveCajaId,
  }, { excludeUserId: id });

  const uid = (existing.uid as string) || id;
  const nextPassword =
    typeof data.password === "string" ? data.password.trim() : "";

  const authUpdate: Record<string, unknown> = {};
  if (data.email) authUpdate.email = data.email.toLowerCase().trim();
  if (nextPassword) authUpdate.password = nextPassword;
  if (data.nombre) authUpdate.displayName = data.nombre;
  if (data.activo !== undefined) authUpdate.disabled = data.activo === false;
  if (Object.keys(authUpdate).length > 0) {
    try {
      await authAppOficial.updateUser(uid, authUpdate);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "auth/email-already-exists") {
        throw new ApiError(
          409,
          "Ya existe un usuario con ese email",
          true,
          "EMAIL_ALREADY_EXISTS",
        );
      }
      if (code === "auth/weak-password" || code === "auth/invalid-password") {
        throw new ApiError(
          400,
          "La contraseña no es válida (mínimo 6 caracteres)",
          true,
          "WEAK_PASSWORD",
        );
      }
      if (code === "auth/user-not-found") {
        throw new ApiError(
          404,
          "Usuario no encontrado en autenticación",
          true,
          "AUTH_USER_NOT_FOUND",
        );
      }
      throw error;
    }
  }

  const firestoreData: Record<string, unknown> = {};
  if (data.nombre !== undefined) firestoreData.nombre = data.nombre;
  if (data.email !== undefined) {
    firestoreData.email = data.email.toLowerCase().trim();
  }
  if (data.fecha_nacimiento !== undefined) {
    firestoreData.fecha_nacimiento = data.fecha_nacimiento;
    firestoreData.fechaNacimiento = data.fecha_nacimiento;
    firestoreData.edad = calcularEdad(data.fecha_nacimiento);
  }
  if (data.activo !== undefined) firestoreData.activo = data.activo;
  if (data.concesionId !== undefined) {
    firestoreData.concesionId = data.concesionId;
  }
  // Siempre persistir asignación efectiva: vendedor puede cambiar caja;
  // admin/otros limpian sucursal/caja.
  if (
    data.sucursalId !== undefined ||
    data.rol !== undefined ||
    mergedRol !== UserRole.VENDEDOR
  ) {
    firestoreData.sucursalId = effectiveSucursalId;
  }
  if (
    data.cajaId !== undefined ||
    data.rol !== undefined ||
    mergedRol !== UserRole.VENDEDOR
  ) {
    firestoreData.cajaId = effectiveCajaId;
  }
  if (data.rol !== undefined) {
    const concesionRole = toConcesionRole(data.rol);
    firestoreData.rol = concesionRole;
    await authAppOficial.setCustomUserClaims(uid, {
      admin: false,
      rol: concesionRole,
    });
  }

  await ref.update({
    ...firestoreData,
    from_concesion: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const updated = await ref.get();
  return toData(updated);
};

export const assignVendedorToSucursalCaja = async (
  userId: string,
  data: { sucursalId: string; cajaId: string | null },
  adminConcesionId: string,
) => {
  const ref = usuariosCol().doc(userId);
  const doc = await ref.get();
  if (!doc.exists || doc.data()?.from_concesion !== true) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const existing = doc.data() ?? {};
  const rol = normalizeInternalRole(existing.rol as string);
  if (rol !== UserRole.VENDEDOR) {
    throw new ApiError(
      400,
      "Solo se puede asignar sucursal/caja a vendedores",
      true,
      "INVALID_ROLE",
    );
  }
  if (existing.concesionId !== adminConcesionId) {
    throw new ApiError(
      403,
      "El vendedor no pertenece a tu concesión",
      true,
      "FORBIDDEN",
    );
  }

  await validateUserBusinessRules({
    rol: UserRole.VENDEDOR,
    concesionId: adminConcesionId,
    sucursalId: data.sucursalId,
    cajaId: data.cajaId,
  }, { excludeUserId: userId });

  await ref.update({
    sucursalId: data.sucursalId,
    cajaId: data.cajaId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteUser = async (id: string) => {
  const ref = usuariosCol().doc(id);
  const doc = await ref.get();
  if (!doc.exists || doc.data()?.from_concesion !== true) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }
  const uid = (doc.data()?.uid as string) || id;

  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
  try {
    await authAppOficial.updateUser(uid, { disabled: true });
  } catch {
    // Si el usuario no existe en Auth, continuamos con el soft delete lógico.
  }
};

/** Eliminación física en Auth (app-oficial) y Firestore usuariosApp. */
export const hardDeleteUser = async (id: string, actorUid?: string) => {
  const ref = usuariosCol().doc(id);
  const doc = await ref.get();
  if (!doc.exists || doc.data()?.from_concesion !== true) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }
  const uid = (doc.data()?.uid as string) || id;

  if (actorUid && (actorUid === id || actorUid === uid)) {
    throw new ApiError(
      400,
      "No puedes eliminar tu propio usuario",
      true,
      "CANNOT_DELETE_SELF",
    );
  }

  try {
    await authAppOficial.deleteUser(uid);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "auth/user-not-found") {
      throw error;
    }
  }

  await ref.delete();
};
