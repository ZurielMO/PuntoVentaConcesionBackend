import { admin } from "../config/firebase.admin";
import {
  firestoreApp,
  USUARIOS_APP_COLLECTION,
} from "../config/app.firebase";
import {
  AbonadoBenefitDefinition,
  AbonadoBenefitType,
  isQuantityPromo,
  mapDescuentoToBenefit,
} from "../config/abonado-benefits.config";
import { firestorePos } from "../config/firebase";
import { COLLECTIONS } from "../config/firestore.constants";
import { getDescuentoById, listDescuentos } from "./descuento.service";
import { buildJornadaId } from "./asignacion-caja.service";
import { resolveJornadaPrimaria } from "./jornada.service";
import { ApiError } from "../utils/api-error";

type SeasonPassVerification = {
  isSubscriber?: boolean;
  event?: string;
  season?: string;
  phone?: string;
  posBeneficiosConsumidos?: Record<
    string,
    { ventaId?: string; consumedAt?: admin.firestore.Timestamp }
  >;
};

export interface AbonadoBenefitStatus {
  id: string;
  titulo: string;
  descripcion: string;
  tipo: AbonadoBenefitType;
  productIds: string[];
  concesionIds: string[];
  valor?: number | null;
  disponible: boolean;
}

export interface AbonadoVerificationResult {
  memberId: string;
  nombre: string;
  email: string;
  isSubscriber: boolean;
  event?: string;
  season?: string;
  benefits: AbonadoBenefitStatus[];
}

export interface ConsumeAbonadoBenefitResult {
  memberId: string;
  benefitId: string;
  ventaId: string;
  consumedAt: string;
}

const usuariosCol = () => firestoreApp.collection(USUARIOS_APP_COLLECTION);

const mapAppOficialFirestoreError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  if (/PERMISSION_DENIED|Missing or insufficient permissions/i.test(message)) {
    throw new ApiError(
      503,
      "No hay acceso a perfiles de app-oficial-leon. Configura SERVICE_ACCOUNT_APP_OFICIAL o concede roles/datastore.user al service account de apiV2 en ese proyecto.",
      false,
      "APP_OFICIAL_PERMISSION_DENIED",
    );
  }
  throw error;
};

const getUserDocumentByUid = async (uid: string) => {
  try {
    const directRef = usuariosCol().doc(uid);
    const directSnap = await directRef.get();
    if (directSnap.exists) {
      return { ref: directRef, snap: directSnap };
    }

    const snapshot = await usuariosCol().where("uid", "==", uid).limit(1).get();
    if (snapshot.empty) {
      return null;
    }

    const snap = snapshot.docs[0];
    return { ref: snap.ref, snap };
  } catch (error) {
    return mapAppOficialFirestoreError(error);
  }
};

const loadActiveDescuentoBenefits = async (
  concesionId?: string | null,
): Promise<AbonadoBenefitDefinition[]> => {
  const trimmed = concesionId?.trim();
  if (!trimmed) return [];

  const rows = (await listDescuentos({
    concesionId: trimmed,
    includeInactive: false,
  })) as Array<Record<string, unknown> & { id: string }>;

  return rows
    .map(mapDescuentoToBenefit)
    .filter((item): item is AbonadoBenefitDefinition => item != null)
    .filter(
      (item) =>
        item.concesionIds.length === 0 || item.concesionIds.includes(trimmed),
    );
};

const toBenefitStatus = (
  definition: AbonadoBenefitDefinition,
  disponible: boolean,
): AbonadoBenefitStatus => ({
  id: definition.id,
  titulo: definition.titulo,
  descripcion: definition.descripcion,
  tipo: definition.tipo,
  productIds: definition.productIds,
  concesionIds: definition.concesionIds,
  valor: definition.valor ?? null,
  disponible,
});

const consumosCol = () =>
  firestorePos.collection(COLLECTIONS.ABONADO_BENEFICIOS_CONSUMIDOS);

const buildConsumoId = (
  jornadaId: string,
  memberId: string,
  benefitId: string,
) => `${jornadaId}__${memberId}__${benefitId}`;

const resolveJornadaIdActiva = async (): Promise<string> => {
  const { jornadaNumero, fecha } = await resolveJornadaPrimaria();
  return buildJornadaId(fecha, jornadaNumero);
};

/**
 * Beneficios de un solo uso que este abonado ya gastó en la jornada activa.
 *
 * Solo 2x1/3x2 se agotan: uno por promoción, por abonado, por jornada. Los de
 * monto o porcentaje (p. ej. cerveza) se pueden usar cuantas veces quiera.
 * Si no hay jornada activa no se bloquea el escaneo.
 */
const loadBeneficiosConsumidos = async (
  memberId: string,
  definitions: AbonadoBenefitDefinition[],
): Promise<Set<string>> => {
  const limitados = definitions.filter((item) => isQuantityPromo(item.tipo));
  if (limitados.length === 0) return new Set();

  let jornadaId: string;
  try {
    jornadaId = await resolveJornadaIdActiva();
  } catch (error) {
    console.error("No se pudo resolver la jornada para beneficios", error);
    return new Set();
  }

  const snaps = await firestorePos.getAll(
    ...limitados.map((item) =>
      consumosCol().doc(buildConsumoId(jornadaId, memberId, item.id)),
    ),
  );

  const consumidos = new Set<string>();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const benefitId = snap.data()?.benefitId;
    if (typeof benefitId === "string") consumidos.add(benefitId);
  }
  return consumidos;
};

export const verifyAbonado = async (
  memberId: string,
  concesionId?: string | null,
): Promise<AbonadoVerificationResult> => {
  const trimmedId = memberId.trim();
  if (!trimmedId) {
    throw new ApiError(400, "ID de abonado inválido", true, "INVALID_MEMBER_ID");
  }

  const userDocument = await getUserDocumentByUid(trimmedId);
  if (!userDocument) {
    throw new ApiError(404, "Usuario no encontrado", true, "MEMBER_NOT_FOUND");
  }

  const data = userDocument.snap.data() ?? {};
  const verification = data.seasonPassVerification as
    | SeasonPassVerification
    | undefined;
  const isSubscriber = verification?.isSubscriber === true;

  if (!isSubscriber) {
    throw new ApiError(
      404,
      "No es abonado activo o no tiene Fierabono verificado",
      true,
      "NOT_SUBSCRIBER",
    );
  }

  const nombre =
    (data.nombre as string | undefined)?.trim() ||
    (data.displayName as string | undefined)?.trim() ||
    "Abonado";
  const email = (data.email as string | undefined)?.trim() ?? "";

  let benefits: AbonadoBenefitStatus[] = [];
  try {
    const definitions = await loadActiveDescuentoBenefits(concesionId);
    const consumidos = await loadBeneficiosConsumidos(
      userDocument.snap.id,
      definitions,
    );
    benefits = definitions.map((definition) =>
      toBenefitStatus(definition, !consumidos.has(definition.id)),
    );
  } catch (error) {
    console.error("No se pudieron leer descuentos activos de la concesión", error);
  }

  return {
    memberId: userDocument.snap.id,
    nombre,
    email,
    isSubscriber: true,
    event: verification?.event,
    season: verification?.season,
    benefits,
  };
};

export const consumeAbonadoBenefit = async (params: {
  memberId: string;
  benefitId: string;
  ventaId: string;
}): Promise<ConsumeAbonadoBenefitResult> => {
  const trimmedId = params.memberId.trim();
  const benefitId = params.benefitId.trim();
  const ventaId = params.ventaId.trim();

  if (!trimmedId) {
    throw new ApiError(400, "ID de abonado inválido", true, "INVALID_MEMBER_ID");
  }
  if (!benefitId) {
    throw new ApiError(400, "Beneficio inválido", true, "INVALID_BENEFIT_ID");
  }
  if (!ventaId) {
    throw new ApiError(400, "ID de venta inválido", true, "INVALID_VENTA_ID");
  }

  const descuento = (await getDescuentoById(benefitId)) as Record<
    string,
    unknown
  > & { id: string };
  const mapped = mapDescuentoToBenefit(descuento);
  if (!mapped) {
    throw new ApiError(
      404,
      "El descuento no está activo o no aplica a abonados",
      true,
      "BENEFIT_NOT_FOUND",
    );
  }

  const userDocument = await getUserDocumentByUid(trimmedId);
  if (!userDocument) {
    throw new ApiError(404, "Usuario no encontrado", true, "MEMBER_NOT_FOUND");
  }

  const data = userDocument.snap.data() ?? {};
  const verification = (data.seasonPassVerification ?? {}) as SeasonPassVerification;

  if (verification.isSubscriber !== true) {
    throw new ApiError(
      403,
      "El usuario ya no es abonado activo",
      true,
      "NOT_SUBSCRIBER",
    );
  }

  const memberDocId = userDocument.snap.id;

  // Monto y porcentaje no se agotan; solo 2x1/3x2 se limitan por jornada.
  if (!isQuantityPromo(mapped.tipo)) {
    return {
      memberId: memberDocId,
      benefitId,
      ventaId,
      consumedAt: new Date().toISOString(),
    };
  }

  const jornadaId = await resolveJornadaIdActiva();
  const consumoRef = consumosCol().doc(
    buildConsumoId(jornadaId, memberDocId, benefitId),
  );

  const consumedAt = await firestorePos.runTransaction(async (tx) => {
    const snap = await tx.get(consumoRef);
    if (snap.exists) {
      // Ya se gastó en esta jornada: se respeta el primer consumo.
      const previo = snap.data()?.consumedAt;
      return typeof previo === "string" ? previo : new Date().toISOString();
    }

    const now = new Date().toISOString();
    tx.set(consumoRef, {
      memberId: memberDocId,
      benefitId,
      tipo: mapped.tipo,
      jornadaId,
      ventaId,
      consumedAt: now,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return now;
  });

  return {
    memberId: memberDocId,
    benefitId,
    ventaId,
    consumedAt,
  };
};
