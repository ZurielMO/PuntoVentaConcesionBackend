import { FieldValue } from "firebase-admin/firestore";
import { authAdmin, firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";

const col = () => firestorePos.collection(COLLECTIONS.USERS);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => {
  const data = doc.data() ?? {};
  // Nunca exponemos password.
  const { password, ...rest } = data as Record<string, unknown>;
  void password;
  return { id: doc.id, ...rest };
};

export const listUsers = async () => {
  const snap = await col().get();
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
}) => {
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
      throw new ApiError(
        409,
        "Ya existe un usuario con ese email",
        true,
        "EMAIL_ALREADY_EXISTS",
      );
    }
    throw error;
  }

  const docData = {
    uid: authUser.uid,
    nombre: data.nombre,
    fecha_nacimiento: data.fecha_nacimiento,
    email: data.email.toLowerCase(),
    rol: data.rol,
    activo: data.activo ?? true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await col().doc(authUser.uid).set(docData);
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
  }>,
) => {
  const ref = col().doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    throw new ApiError(404, "Usuario no encontrado", true, "NOT_FOUND");
  }

  const uid = (doc.data()?.uid as string) || id;

  // Sincronizar con Firebase Auth cuando aplique.
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

  await ref.update({
    ...firestoreData,
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
