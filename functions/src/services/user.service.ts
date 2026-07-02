import { FieldValue } from "firebase-admin/firestore";
import { authAdmin, firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import { UserRole } from "../models";
import { assertCajaBelongsToSucursal } from "./sucursal.service";

const col = () => firestorePos.collection(COLLECTIONS.USERS);
const concessionsCol = () => firestorePos.collection(COLLECTIONS.CONCESIONES);
const sucursalesCol = () => firestorePos.collection(COLLECTIONS.SUCURSALES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, unknown> & { id: string } => {
  const data = doc.data() ?? {};
  const { password, ...rest } = data as Record<string, unknown>;
  void password;
  return { id: doc.id, ...rest };
};

const normalizeRole = (rol: string): string =>
  rol === "EMPLEADO" ? UserRole.VENDEDOR : rol.toUpperCase();

const assertConcessionExists = async (concesionId: string) => {
  const doc = await concessionsCol().doc(concesionId).get();
  if (!doc.exists || doc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada", true, "NOT_FOUND");
  }
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
};

const validateUserBusinessRules = async (data: {
  rol: string;
  concesionId?: string | null;
  sucursalId?: string | null;
  cajaId?: string | null;
}) => {
  const rol = normalizeRole(data.rol);

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

  await assertConcessionExists(data.concesionId);

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
    }
  }
};

export const listVendedoresByConcesion = async (concesionId: string) => {
  const snap = await col()
    .where("concesionId", "==", concesionId)
    .where("rol", "==", UserRole.VENDEDOR)
    .get();
  return snap.docs.map(toData).filter((u) => u.activo !== false);
};

export const listUsers = async (concesionId?: string) => {
  let query: FirebaseFirestore.Query = col();
  if (concesionId) {
    query = query.where("concesionId", "==", concesionId);
  }
  const snap = await query.get();
  return snap.docs.map(toData);
};

export const getUserById = async (id: string) => {
  const doc = await col().doc(id).get();
  if (!doc.exists) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }
  return toData(doc);
};

export const createUser = async (data: {
  nombre: string;
  fecha_nacimiento: string;
  email: string;
  password: string;
  rol: string;
  activo?: boolean;
  concesionId?: string | null;
  sucursalId?: string | null;
  cajaId?: string | null;
}) => {
  const normalizedRole = normalizeRole(data.rol);
  await validateUserBusinessRules({
    rol: normalizedRole,
    concesionId: data.concesionId,
    sucursalId: data.sucursalId,
    cajaId: data.cajaId,
  });

  let authUser;
  try {
    authUser = await authAdmin.createUser({
      email: data.email,
      password: data.password,
      displayName: data.nombre,
      disabled: data.activo === false,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      throw new ApiError(409, "Ya existe un usuario con ese email", true, "EMAIL_ALREADY_EXISTS");
    }
    throw error;
  }

  const docData: Record<string, unknown> = {
    uid: authUser.uid,
    nombre: data.nombre,
    fecha_nacimiento: data.fecha_nacimiento,
    email: data.email.toLowerCase(),
    rol: normalizedRole,
    activo: data.activo ?? true,
    concesionId: data.concesionId ?? null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (normalizedRole === UserRole.VENDEDOR && data.sucursalId) {
    docData.sucursalId = data.sucursalId;
  }
  if (normalizedRole === UserRole.VENDEDOR && data.cajaId) {
    docData.cajaId = data.cajaId;
  }

  try {
    await col().doc(authUser.uid).set(docData);
  } catch (error) {
    try {
      await authAdmin.deleteUser(authUser.uid);
    } catch {
      // best effort rollback
    }
    throw error;
  }

  const doc = await col().doc(authUser.uid).get();
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
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const existing = doc.data() ?? {};
  const mergedRol = data.rol ? normalizeRole(data.rol) : (existing.rol as string);
  const mergedConcesionId =
    data.concesionId !== undefined ? data.concesionId : (existing.concesionId as string | null);
  const mergedSucursalId =
    data.sucursalId !== undefined ? data.sucursalId : (existing.sucursalId as string | null);
  const mergedCajaId =
    data.cajaId !== undefined ? data.cajaId : (existing.cajaId as string | null);

  if (mergedRol === UserRole.SUPERADMIN) {
    throw new ApiError(403, "No se puede asignar rol SUPERADMIN", true, "FORBIDDEN");
  }

  await validateUserBusinessRules({
    rol: mergedRol,
    concesionId: mergedConcesionId,
    sucursalId: mergedSucursalId,
    cajaId: mergedCajaId,
  });

  const uid = (existing.uid as string) || id;

  const authUpdate: Record<string, unknown> = {};
  if (data.email) authUpdate.email = data.email;
  if (data.password) authUpdate.password = data.password;
  if (data.nombre) authUpdate.displayName = data.nombre;
  if (data.activo !== undefined) authUpdate.disabled = data.activo === false;
  if (Object.keys(authUpdate).length > 0) {
    try {
      await authAdmin.updateUser(uid, authUpdate);
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
  }

  const { password, ...firestoreData } = data;
  void password;
  if (firestoreData.email) {
    firestoreData.email = firestoreData.email.toLowerCase();
  }
  if (firestoreData.rol) {
    firestoreData.rol = normalizeRole(firestoreData.rol);
  }

  await ref.update({
    ...firestoreData,
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
  const ref = col().doc(userId);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const existing = doc.data() ?? {};
  const rol = normalizeRole(existing.rol as string);
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
  });

  await ref.update({
    sucursalId: data.sucursalId,
    cajaId: data.cajaId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const updated = await ref.get();
  return toData(updated);
};

export const softDeleteUser = async (id: string) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }
  const uid = (doc.data()?.uid as string) || id;

  await ref.update({ activo: false, updatedAt: FieldValue.serverTimestamp() });
  try {
    await authAdmin.updateUser(uid, { disabled: true });
  } catch {
    // Si el usuario no existe en Auth, continuamos con el soft delete lógico.
  }
};
