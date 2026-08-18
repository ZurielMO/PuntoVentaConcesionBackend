import { admin } from "../config/firebase.admin";
import {
  firestoreApp,
  USUARIOS_APP_COLLECTION,
} from "../config/app.firebase";
import {
  ABONADO_BENEFITS_CATALOG,
  AbonadoBenefitDefinition,
  filterBenefitsForConcesion,
  getBenefitDefinition,
  isOnceOnlyBenefit,
} from "../config/abonado-benefits.config";
import { getConcessionNombre } from "./concession.service";
import { listDescuentos } from "./descuento.service";
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
  tipo: AbonadoBenefitDefinition["tipo"];
  productNameTokens: string[];
  productIds: string[];
  concesionIds: string[];
  concesionNombreTokens: string[];
  subscriberPrice?: number;
  disponible: boolean;
  consumidoAt?: string;
  consumidoVentaId?: string;
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

const serializeTimestamp = (value: unknown): string | undefined => {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return undefined;
};

const loadActive2x1ProductIds = async (
  concesionId?: string | null,
): Promise<string[]> => {
  if (!concesionId?.trim()) return [];

  const descuentos = (await listDescuentos({
    concesionId: concesionId.trim(),
    includeInactive: true,
  })) as Array<{
    activo?: boolean;
    tipo?: string;
    producto_ids?: unknown;
  }>;

  return descuentos
    .filter(
      (item) =>
        item.activo !== false &&
        String(item.tipo ?? "").toUpperCase() === "2X1",
    )
    .flatMap((item) =>
      Array.isArray(item.producto_ids)
        ? item.producto_ids.map((id) => String(id).trim()).filter(Boolean)
        : [],
    );
};

const attachActive2x1ProductIds = (
  definitions: AbonadoBenefitDefinition[],
  productIds: string[],
): AbonadoBenefitDefinition[] => {
  if (productIds.length === 0) {
    return definitions;
  }

  const withIce = definitions.some((item) => item.id === "ice-2x1")
    ? definitions
    : [
        ...definitions,
        ...ABONADO_BENEFITS_CATALOG.filter((item) => item.id === "ice-2x1"),
      ];

  return withIce.map((definition) => {
    if (definition.tipo !== "buy_one_get_one") {
      return definition;
    }
    return {
      ...definition,
      productIds: [...new Set([...(definition.productIds ?? []), ...productIds])],
    };
  });
};

const buildBenefitStatuses = (
  verification: SeasonPassVerification | undefined,
  definitions: AbonadoBenefitDefinition[],
  options?: { keepOnceOnlyAvailable?: boolean },
): AbonadoBenefitStatus[] => {
  const consumed = verification?.posBeneficiosConsumidos ?? {};

  return definitions.map((definition) => {
    const usage = consumed[definition.id];
    const consumidoAt = serializeTimestamp(usage?.consumedAt);

    return {
      id: definition.id,
      titulo: definition.titulo,
      descripcion: definition.descripcion,
      tipo: definition.tipo,
      productNameTokens: definition.productNameTokens,
      productIds: definition.productIds ?? [],
      concesionIds: definition.concesionIds ?? [],
      concesionNombreTokens: definition.concesionNombreTokens ?? [],
      subscriberPrice: definition.subscriberPrice,
      // onceOnly (ICE 2x1): unavailable after first consume.
      // Permanent benefits (cerveza abonado): always disponible.
      disponible:
        options?.keepOnceOnlyAvailable === true ||
        !isOnceOnlyBenefit(definition) ||
        !consumidoAt,
      consumidoAt,
      consumidoVentaId: usage?.ventaId,
    };
  });
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

  const concesionNombre = concesionId
    ? await getConcessionNombre(concesionId)
    : null;
  let scopedDefinitions = filterBenefitsForConcesion(
    ABONADO_BENEFITS_CATALOG,
    concesionId,
    concesionNombre,
  );
  let active2x1ProductIds: string[] = [];
  try {
    active2x1ProductIds = await loadActive2x1ProductIds(concesionId);
    scopedDefinitions = attachActive2x1ProductIds(
      scopedDefinitions,
      active2x1ProductIds,
    );
  } catch (error) {
    console.error("No se pudieron leer descuentos 2x1 activos", error);
  }

  console.log("[abonado] verify", {
    memberId: userDocument.snap.id,
    concesionId: concesionId ?? null,
    concesionNombre,
    benefitIds: scopedDefinitions.map((item) => item.id),
    active2x1ProductIds,
  });

  return {
    memberId: userDocument.snap.id,
    nombre,
    email,
    isSubscriber: true,
    event: verification?.event,
    season: verification?.season,
    benefits: buildBenefitStatuses(verification, scopedDefinitions, {
      keepOnceOnlyAvailable: active2x1ProductIds.length > 0,
    }),
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

  const definition = getBenefitDefinition(benefitId);
  if (!definition) {
    throw new ApiError(404, "Beneficio no encontrado", true, "BENEFIT_NOT_FOUND");
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

  // Permanent benefits (e.g. cerveza precio abonado): no once-only tracking.
  if (!isOnceOnlyBenefit(definition)) {
    return {
      memberId: userDocument.snap.id,
      benefitId,
      ventaId,
      consumedAt: new Date().toISOString(),
    };
  }

  const consumed = { ...(verification.posBeneficiosConsumidos ?? {}) };
  const existing = consumed[benefitId];
  if (existing?.consumedAt) {
    throw new ApiError(
      409,
      "Este beneficio ya fue consumido",
      true,
      "BENEFIT_ALREADY_CONSUMED",
    );
  }

  const consumedAt = admin.firestore.Timestamp.now();
  consumed[benefitId] = { ventaId, consumedAt };

  await userDocument.ref.update({
    seasonPassVerification: {
      ...verification,
      posBeneficiosConsumidos: consumed,
    },
  });

  return {
    memberId: userDocument.snap.id,
    benefitId,
    ventaId,
    consumedAt: consumedAt.toDate().toISOString(),
  };
};
