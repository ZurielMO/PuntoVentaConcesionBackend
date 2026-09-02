import { FieldValue } from "firebase-admin/firestore";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { ApiError } from "../utils/api-error";
import * as sucursalService from "./sucursal.service";
import { getUserById } from "./user.service";

const col = () => firestorePos.collection(COLLECTIONS.ASIGNACIONES_CAJAS_JORNADA);

const toData = (doc: FirebaseFirestore.DocumentSnapshot) => ({
  id: doc.id,
  ...doc.data(),
});

export type JornadaRama = "varonil" | "femenil";

export const normalizeRama = (rama?: string | null): JornadaRama =>
  rama === "femenil" ? "femenil" : "varonil";

/** Varonil: `2026-09-07__J6`. Femenil: `2026-09-07__J6__femenil`. */
export const buildJornadaId = (
  fecha: string,
  jornadaNumero: number | string,
  rama: JornadaRama | string | null | undefined = "varonil",
) => {
  const r = normalizeRama(rama);
  return r === "femenil"
    ? `${fecha}__J${jornadaNumero}__femenil`
    : `${fecha}__J${jornadaNumero}`;
};

const JORNADA_ID_RE = /^(\d{4}-\d{2}-\d{2})__J(\d+)(?:__(femenil))?$/;

/** Parsea `2026-07-10__J1` o `2026-07-10__J1__femenil`. */
export const parseJornadaId = (
  jornadaId: string,
): { fecha: string; numero: number; rama: JornadaRama } => {
  const match = jornadaId.trim().match(JORNADA_ID_RE);
  if (!match) {
    throw new ApiError(400, "jornadaId inválido", true, "INVALID_JORNADA_ID");
  }
  return {
    fecha: match[1],
    numero: Number(match[2]),
    rama: match[3] === "femenil" ? "femenil" : "varonil",
  };
};

/** Detecta `__femenil` en ids de jornada/inventario (`…__J6__femenil` / `…__J6__femenil__{suc}`). */
export const ramaFromId = (id?: string | null): JornadaRama | null => {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  if (/(?:^|__)femenil(?:__|$)/.test(raw)) return "femenil";
  // Ids de jornada/inventario con forma fecha__J#: sin sufijo = varonil.
  if (/^\d{4}-\d{2}-\d{2}__J\d+/.test(raw)) return "varonil";
  return null;
};

/**
 * Rama del inventario: campo `rama` explícito → id del doc → default varonil.
 * El id evita etiquetar como Varonil inventarios `…__femenil__…` legacy sin campo.
 */
export const ramaFromInventario = (
  data:
    | { rama?: unknown; id?: unknown }
    | Record<string, unknown>
    | null
    | undefined,
  inventarioId?: string | null,
): JornadaRama => {
  if (data && typeof data === "object") {
    const rawRama = "rama" in data ? data.rama : undefined;
    if (rawRama === "femenil" || rawRama === "varonil") {
      return normalizeRama(rawRama as string);
    }
  }
  const idCandidate =
    (inventarioId != null && String(inventarioId)) ||
    (data && typeof data === "object" && "id" in data
      ? String(data.id ?? "")
      : "");
  return ramaFromId(idCandidate) ?? "varonil";
};

/**
 * Alinea jornadaId con la rama real del inventario (ventas/cortes mal etiquetados).
 * No borra comprobantes: solo corrige el id de etiqueta.
 */
export const alignJornadaIdWithInventario = (
  jornadaId: string | null | undefined,
  inventarioId: string | null | undefined,
): string | null => {
  const invId = String(inventarioId ?? "").trim();
  const current = String(jornadaId ?? "").trim();
  const ramaInv = ramaFromId(invId);
  if (!ramaInv || !invId) return current || null;

  try {
    if (current) {
      const parsed = parseJornadaId(current);
      if (parsed.rama === ramaInv) return current;
      return buildJornadaId(parsed.fecha, parsed.numero, ramaInv);
    }
  } catch {
    // jornadaId inválido o solo-fecha: intentar desde inventario
  }

  const match = invId.match(/^(\d{4}-\d{2}-\d{2})__J(\d+)/);
  if (match) return buildJornadaId(match[1], Number(match[2]), ramaInv);
  return current || null;
};

export const listAsignacionesCajas = async (params: {
  jornadaId: string;
  sucursalId?: string;
  concesionId?: string;
}) => {
  let query: FirebaseFirestore.Query = col()
    .where("jornadaId", "==", params.jornadaId)
    .where("activo", "==", true);

  if (params.sucursalId) {
    query = query.where("sucursalId", "==", params.sucursalId);
  }
  if (params.concesionId) {
    query = query.where("concesionId", "==", params.concesionId);
  }

  const snap = await query.get();
  return snap.docs.map(toData);
};

export const upsertAsignacionesCajas = async (params: {
  jornadaId: string;
  concesionId: string;
  sucursalId: string;
  asignaciones: { cajaId: string; vendedorUid: string | null }[];
}) => {
  const vendedoresUsados = new Set<string>();
  for (const item of params.asignaciones) {
    if (!item.vendedorUid) continue;
    if (vendedoresUsados.has(item.vendedorUid)) {
      throw new ApiError(
        400,
        "Un vendedor no puede estar asignado a más de una caja en la misma jornada",
        true,
        "VENDEDOR_DUPLICADO",
      );
    }
    vendedoresUsados.add(item.vendedorUid);
  }

  const existingSnap = await col()
    .where("jornadaId", "==", params.jornadaId)
    .where("sucursalId", "==", params.sucursalId)
    .where("activo", "==", true)
    .get();

  const batch = firestorePos.batch();
  existingSnap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      activo: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  for (const item of params.asignaciones) {
    if (!item.vendedorUid) continue;

    const caja = await sucursalService.assertCajaBelongsToSucursal(
      params.sucursalId,
      item.cajaId,
    );
    const vendedor = await getUserById(item.vendedorUid);
    if (vendedor.concesionId !== params.concesionId) {
      throw new ApiError(
        400,
        "El vendedor no pertenece a esta concesión",
        true,
        "INVALID_VENDEDOR",
      );
    }
    if (vendedor.sucursalId && vendedor.sucursalId !== params.sucursalId) {
      throw new ApiError(
        400,
        "El vendedor no pertenece a esta sucursal",
        true,
        "INVALID_VENDEDOR_SUCURSAL",
      );
    }

    const ref = col().doc();
    batch.set(ref, {
      jornadaId: params.jornadaId,
      concesionId: params.concesionId,
      sucursalId: params.sucursalId,
      cajaId: item.cajaId,
      cajaNombre: caja.nombre,
      vendedorUid: item.vendedorUid,
      vendedorNombre: (vendedor.nombre as string) ?? "Vendedor",
      activo: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
  return listAsignacionesCajas({
    jornadaId: params.jornadaId,
    sucursalId: params.sucursalId,
    concesionId: params.concesionId,
  });
};

export const resolveCajaActivaParaVendedor = async (params: {
  vendedorUid: string;
  jornadaId: string;
  sucursalId: string;
  fallbackCajaId?: string | null;
}): Promise<{ cajaId: string; cajaNombre: string } | null> => {
  const snap = await col()
    .where("jornadaId", "==", params.jornadaId)
    .where("sucursalId", "==", params.sucursalId)
    .where("vendedorUid", "==", params.vendedorUid)
    .where("activo", "==", true)
    .limit(1)
    .get();

  if (!snap.empty) {
    const data = snap.docs[0].data();
    return {
      cajaId: data.cajaId as string,
      cajaNombre: data.cajaNombre as string,
    };
  }

  if (params.fallbackCajaId) {
    const caja = await sucursalService.getCajaById(
      params.sucursalId,
      params.fallbackCajaId,
    );
    if (caja.activo !== false) {
      return {
        cajaId: caja.id,
        cajaNombre: caja.nombre as string,
      };
    }
  }

  return null;
};

export const getCajaIdsForVendedorEnJornada = async (params: {
  vendedorUid: string;
  jornadaId: string;
  sucursalId: string;
  fallbackCajaId?: string | null;
}): Promise<string[]> => {
  const resolved = await resolveCajaActivaParaVendedor(params);
  return resolved ? [resolved.cajaId] : [];
};
