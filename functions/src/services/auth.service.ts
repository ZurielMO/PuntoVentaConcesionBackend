import axios from "axios";
import { authAdmin } from "../config/firebase";
import { ApiError } from "../utils/api-error";

const getFirebaseApiKey = (): string => {
  const key =
    process.env.FIREBASE_API_KEY ||
    process.env.CLIENT_FIREBASE_API_KEY ||
    process.env.AUTH_API_KEY ||
    "";
  if (!key) {
    throw new ApiError(
      500,
      "Login por contraseña no configurado (falta FIREBASE_API_KEY)",
      false,
      "AUTH_NOT_CONFIGURED",
    );
  }
  return key;
};

/** Verifica un Firebase ID token y devuelve el contenido decodificado. */
export const verifyIdToken = async (idToken: string) => {
  try {
    return await authAdmin.verifyIdToken(idToken);
  } catch {
    throw new ApiError(401, "Token inválido o expirado", true, "INVALID_TOKEN");
  }
};

/**
 * Login DEV con email/password vía Identity Toolkit (signInWithPassword).
 * Devuelve un idToken válido que luego verificamos.
 */
export const loginWithPassword = async (email: string, password: string) => {
  const apiKey = getFirebaseApiKey();
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;

  let idToken: string;
  try {
    const resp = await axios.post(url, {
      email,
      password,
      returnSecureToken: true,
    });
    idToken = resp.data.idToken;
  } catch {
    throw new ApiError(
      401,
      "Credenciales inválidas",
      true,
      "INVALID_CREDENTIALS",
    );
  }

  const decoded = await verifyIdToken(idToken);
  return { token: idToken, usuario: decoded };
};
