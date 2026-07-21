import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import type { OperationalListFilters } from "../utils/list-filters.util";

const col = () => firestorePos.collection(COLLECTIONS.CORTES);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export const todayIsoDate = () => new Date().toISOString().slice(0, 10);

export const CORTE_CLOSED_VENTA_MESSAGE =
  "El corte de jornada ya fue cerrado. No se pueden registrar más ventas.";

/** @internal exported for unit tests */
export const matchesCorteCerradoHoy = (
  data: Record<string, unknown>,
  filters: OperationalListFilters,
  fecha: string,
): boolean => {
  if (data.fecha !== fecha || data.estatus !== "CERRADO") {
    return false;
  }
  if (filters.concesionId && data.concesionId !== filters.concesionId) {
    return false;
  }
  if (filters.sucursalId && data.sucursalId !== filters.sucursalId) {
    return false;
  }
  if (filters.cajaId) {
    return data.cajaId === filters.cajaId;
  }
  if (filters.idUser) {
    return data.idUser === filters.idUser;
  }
  return true;
};

/**
 * Busca un corte con estatus CERRADO cuya `fecha` sea hoy (ISO).
 * El bloqueo se levanta al día siguiente automáticamente (nueva fecha).
 * Un corte cerrado es por caja y día cuando `cajaId` está en los filtros.
 */
export const findCorteCerradoHoy = async (
  filters: OperationalListFilters,
): Promise<({ id: string } & Record<string, unknown>) | null> => {
  let query: FirebaseFirestore.Query = col().where("estatus", "==", "CERRADO");
  if (filters.concesionId) {
    query = query.where("concesionId", "==", filters.concesionId);
  }
  if (filters.sucursalId) {
    query = query.where("sucursalId", "==", filters.sucursalId);
  }
  if (filters.cajaId) {
    query = query.where("cajaId", "==", filters.cajaId);
  } else if (filters.idUser) {
    query = query.where("idUser", "==", filters.idUser);
  }

  const fecha = todayIsoDate();
  const snap = await query.get();
  const match = snap.docs.find((doc) =>
    matchesCorteCerradoHoy(doc.data(), filters, fecha),
  );
  if (!match) return null;
  return toData(match);
};

/** @internal exported for unit tests */
export const assertNoCorteCerradoForVenta = (
  corteCerradoHoy: { id: string } | null | undefined,
): void => {
  if (corteCerradoHoy) {
    throw new ApiError(
      409,
      CORTE_CLOSED_VENTA_MESSAGE,
      true,
      "CORTE_ALREADY_CLOSED",
    );
  }
};

export const assertVentaPermitidaConCorte = async (
  filters: OperationalListFilters,
): Promise<void> => {
  const corteCerrado = await findCorteCerradoHoy(filters);
  assertNoCorteCerradoForVenta(corteCerrado);
};
