import { createHash, timingSafeEqual } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { firestorePos } from "../../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../../config/firestore.constants";
import {
  buildTrackingToken,
  getVipBusinessDate,
  getVipCentralZonePassword,
  getVipCurrency,
  getVipReservationTtlMinutes,
  getVipStripeClient,
  getVipStripeWebhookSecret,
  minorToMoney,
  moneyToMinor,
  resolveVipReturnUrls,
  sha256,
  verifyTrackingToken,
} from "../../config/vip.config";
import type { VipAbandonCheckoutInput, VipCheckoutInput } from "../../middleware/validators/vip.validator";
import {
  normalizeVipFloor,
  VipOrder,
  VipOrderItemSnapshot,
  VipOrderStatus,
  VipPaymentStatus,
  VipReservationStatus,
  VipStadiumZone,
} from "../../models/vip.model";
import { ApiError } from "../../utils/api-error";
import { normalizeRecordImageUrls } from "../storage.service";
import { sendVipOrderDeliveredEmail, sendVipOrderPaidEmail } from "./vip-email.service";
import {
  assertVipOrderTransition,
  isVipTerminalStatus,
} from "./vip-state-machine.service";
import { releaseVipStock, reserveVipStock } from "./vip-inventory.service";
import { ramaFromInventario } from "../asignacion-caja.service";

type DocData = FirebaseFirestore.DocumentData;
type Actor = { actorId: string | null; actorRole: string };

type ServiceContext = {
  fecha: string;
  serviceConfigId: string;
  serviceRef: FirebaseFirestore.DocumentReference;
  service: DocData;
};

type ResolvedStockDraw = {
  inventoryId: string;
  sucursalId: string;
  concessionId: string;
  productId: string;
  quantity: number;
};

type ResolvedCheckout = {
  context: ServiceContext;
  delivery: VipOrder["delivery"];
  items: VipOrderItemSnapshot[];
  fulfillments: VipOrder["fulfillments"];
  draws: ResolvedStockDraw[];
  subtotalMinor: number;
  serviceFeeMinor: number;
  tipMinor: number;
  totalMinor: number;
};

const col = (name: string) => firestorePos.collection(name);
const orderCol = () => col(COLLECTIONS.VIP_ORDERS);

const asMillis = (value: unknown): number | null => {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    const rec = value as { toMillis?: () => number; _seconds?: number; seconds?: number };
    if (typeof rec.toMillis === "function") {
      const millis = Number(rec.toMillis());
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof rec._seconds === "number") return rec._seconds * 1000;
    if (typeof rec.seconds === "number") return rec.seconds * 1000;
  }
  return null;
};

const asIso = (value: unknown): string | null => {
  const millis = asMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
};

const activeOrderCount = (data: DocData): number =>
  Math.max(0, Number(data.activeOrderCount || 0));

export const assertVipServiceOpen = (data: DocData, now = Date.now()): void => {
  if (data.enabled === false) {
    throw new ApiError(409, "El servicio a palcos está cerrado.", true, "VIP_SERVICE_CLOSED");
  }
  if (data.acceptingOrders === false) {
    throw new ApiError(409, "El servicio a palcos está pausado.", true, "VIP_SERVICE_PAUSED");
  }
  const opensAt = asMillis(data.opensAt);
  const closesAt = asMillis(data.closesAt);
  if (opensAt !== null && closesAt !== null && (now < opensAt || now > closesAt)) {
    throw new ApiError(409, "El servicio a palcos está fuera de horario.", true, "VIP_SERVICE_CLOSED");
  }
};

export const assertVipCapacity = (data: DocData): void => {
  const maximum = Number(data.maxActiveOrders || 0);
  if (!Number.isInteger(maximum) || maximum <= 0) return;
  const current = Number(data.activeOrderCount || 0);
  if (!Number.isInteger(current) || current < 0) {
    throw new ApiError(503, "La capacidad VIP no está configurada.", true, "VIP_NOT_CONFIGURED");
  }
  if (current >= maximum) {
    throw new ApiError(409, "La operación VIP alcanzó su capacidad máxima.", true, "VIP_CAPACITY_REACHED");
  }
};

const serviceConfigRef = (fecha: string) => col(COLLECTIONS.VIP_SERVICE_CONFIGS).doc(fecha);

const orderServiceRef = (order: Pick<VipOrder, "fecha" | "jornadaId">) =>
  serviceConfigRef(order.fecha || order.jornadaId);

const getServiceContext = async (): Promise<ServiceContext> => {
  const fecha = getVipBusinessDate();
  const serviceRef = serviceConfigRef(fecha);
  const [dateDoc, defaultDoc] = await Promise.all([
    serviceRef.get(),
    col(COLLECTIONS.VIP_SERVICE_CONFIGS).doc("default").get(),
  ]);
  const service = dateDoc.exists
    ? dateDoc.data() || {}
    : defaultDoc.exists
      ? defaultDoc.data() || {}
      : { enabled: true, acceptingOrders: true };
  assertVipServiceOpen(service);
  return {
    fecha,
    serviceConfigId: fecha,
    serviceRef,
    service,
  };
};

type StockSource = {
  sucursalId: string;
  sucursal: DocData;
  inventory: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot;
  productData: DocData;
  availableQuantity: number;
};

const concessionVipEnabled = (config?: DocData | null): boolean => config?.enabled !== false;

const inventoryQuantity = (data?: DocData): number =>
  Number(data?.cantidad_final ?? data?.cantidad_inicial ?? 0);

const preferredSucursalIdFrom = (
  config: DocData | undefined,
  sucursales: Array<{ id: string; data: DocData }>,
): string | null => {
  const configuredId = String(config?.sucursalId || "");
  if (configuredId && sucursales.some((row) => row.id === configuredId)) {
    return configuredId;
  }
  return sucursales.find((row) => row.data.modo_operacion === "POS")?.id || sucursales[0]?.id || null;
};

const compareStockSources = (preferredId: string | null) => (a: StockSource, b: StockSource): number => {
  const preferred = Number(b.sucursalId === preferredId) - Number(a.sucursalId === preferredId);
  if (preferred) return preferred;
  const pos = Number(b.sucursal.modo_operacion === "POS") - Number(a.sucursal.modo_operacion === "POS");
  if (pos) return pos;
  const qty = b.availableQuantity - a.availableQuantity;
  if (qty) return qty;
  return inventoryDocTimestamp(b.inventory.data()) - inventoryDocTimestamp(a.inventory.data());
};

const listActiveSucursalesForConcession = async (
  concessionId: string,
): Promise<{ config: DocData | undefined; sucursales: Array<{ id: string; data: DocData }> }> => {
  const configDoc = await col(COLLECTIONS.VIP_CONCESSION_CONFIG).doc(concessionId).get();
  const config = configDoc.exists ? configDoc.data() : undefined;
  if (!concessionVipEnabled(config)) {
    return { config, sucursales: [] };
  }
  const snap = await col(COLLECTIONS.SUCURSALES).where("concesion_id", "==", concessionId).get();
  const sucursales = snap.docs
    .filter((doc) => doc.data()?.activo !== false && String(doc.data()?.concesion_id || "") === concessionId)
    .map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  return { config, sucursales };
};

const vipSaleDocId = (orderId: string, fulfillment: VipOrder["fulfillments"][number], siblings: VipOrder["fulfillments"]): string => {
  const sameConcession = siblings.filter((row) => row.concessionId === fulfillment.concessionId);
  return sameConcession.length > 1
    ? `vip_${orderId}_${fulfillment.concessionId}_${fulfillment.sucursalId}`
    : `vip_${orderId}_${fulfillment.concessionId}`;
};

const loadOptionalProductConfig = async (productId: string, concessionId: string): Promise<DocData> => {
  const doc = await col(COLLECTIONS.VIP_PRODUCT_CONFIG).doc(productId).get();
  if (!doc.exists) return {};
  const data = doc.data() || {};
  if (data.enabled === false || (data.concessionId && String(data.concessionId) !== concessionId)) {
    throw new ApiError(400, "Uno o más productos no están habilitados para servicio a palcos.", true, "VIP_PRODUCT_DISABLED");
  }
  return data;
};

const toIsoBusinessDate = (raw: unknown): string | null => {
  const value = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dmy = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
};

const inventoryDocTimestamp = (data: DocData | undefined): number =>
  Math.max(asMillis(data?.updatedAt) ?? 0, asMillis(data?.createdAt) ?? 0);

const pickNewestInventory = (
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
): FirebaseFirestore.QueryDocumentSnapshot | null => {
  if (!docs.length) return null;
  const ranked = [...docs].sort((a, b) => {
    const timeDelta = inventoryDocTimestamp(b.data()) - inventoryDocTimestamp(a.data());
    if (timeDelta !== 0) return timeDelta;
    return Number(b.data()?.jornada_numero || 0) - Number(a.data()?.jornada_numero || 0);
  });
  return ranked[0];
};

const isOpenInventoryHeader = (data?: DocData | null): boolean =>
  Boolean(data) && data?.activo === true;

/**
 * Para el servicio a palcos (VIP), una sucursal puede tener headers `activo=true`
 * para `varonil` y `femenil` en paralelo. Este checkout debe usar únicamente
 * el inventario de `varonil`.
 */
const pickPreferredOpenInventory = (
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
): FirebaseFirestore.QueryDocumentSnapshot | null => {
  const businessDate = getVipBusinessDate();

  const varonilOpen = docs
    .filter((doc) => isOpenInventoryHeader(doc.data()))
    .filter((doc) => ramaFromInventario(doc.data(), doc.id) === "varonil");

  if (!varonilOpen.length) return null;

  // Preferir inventario cuya jornada_fecha coincide con el día calendario,
  // pero si no hay (el inventario del partido se abre días antes),
  // usar cualquier inventario varonil activo. `activo` es el control real.
  const sameDate = varonilOpen.filter(
    (doc) => toIsoBusinessDate(doc.data()?.jornada_fecha) === businessDate,
  );

  return pickNewestInventory(sameDate.length ? sameDate : varonilOpen);
};

/**
 * Inventario POS de la sucursal sin depender de RTDB `jornada_activa`.
 * Solo headers abiertos (`activo=true`). `jornada_fecha` es la fecha del partido,
 * no el día calendario: al cambiar de jornada el POS cierra el header anterior.
 */
const findInventoryForSucursal = async (
  sucursalId: string,
): Promise<FirebaseFirestore.DocumentSnapshot | null> => {
  const snap = await col(COLLECTIONS.INVENTARIOS)
    .where("sucursal_id", "==", sucursalId)
    .limit(50)
    .get();
  return pickPreferredOpenInventory(snap.docs);
};

const pickStockSource = async (
  concessionId: string,
  productId: string,
  draws: Array<{ productId: string; quantity: number }>,
): Promise<StockSource> => {
  const { config, sucursales } = await listActiveSucursalesForConcession(concessionId);
  if (!sucursales.length) {
    throw new ApiError(409, "La concesión no tiene sucursal activa para preparar el pedido.", true, "VIP_PRODUCT_DISABLED");
  }
  const preferredId = preferredSucursalIdFrom(config, sucursales);
  const sources: StockSource[] = [];
  for (const sucursal of sucursales) {
    const inventory = await findInventoryForSucursal(sucursal.id);
    if (!inventory) continue;
    const line = await inventory.ref.collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId).get();
    if (!line.exists) continue;
    const productData = line.data() || {};
    sources.push({
      sucursalId: sucursal.id,
      sucursal: sucursal.data,
      inventory,
      productData,
      availableQuantity: inventoryQuantity(productData),
    });
  }
  const viable: StockSource[] = [];
  for (const source of sources) {
    let covers = true;
    for (const draw of draws) {
      const line = draw.productId === productId
        ? source.productData
        : (await source.inventory.ref.collection(SUBCOLLECTIONS.PRODUCTOS).doc(draw.productId).get()).data();
      if (!line || inventoryQuantity(line) < draw.quantity) {
        covers = false;
        break;
      }
    }
    if (covers) viable.push(source);
  }
  const picked = [...viable].sort(compareStockSources(preferredId))[0];
  if (!picked) {
    throw new ApiError(
      409,
      "Uno o más productos no tienen inventario en el POS.",
      true,
      "VIP_OUT_OF_STOCK",
    );
  }
  return picked;
};

const pickCatalogStockLine = (
  productId: string,
  sucursales: Array<{ id: string; data: DocData }>,
  preferredId: string | null,
  inventoryBySucursal: Map<string, FirebaseFirestore.QueryDocumentSnapshot>,
  inventoryProducts: Map<string, Map<string, DocData>>,
): DocData | undefined => {
  const sources: StockSource[] = [];
  for (const sucursal of sucursales) {
    const inventory = inventoryBySucursal.get(sucursal.id);
    if (!inventory) continue;
    const productData = inventoryProducts.get(inventory.id)?.get(productId);
    if (!productData) continue;
    sources.push({
      sucursalId: sucursal.id,
      sucursal: sucursal.data,
      inventory,
      productData,
      availableQuantity: inventoryQuantity(productData),
    });
  }
  const withStock = sources.filter((source) => source.availableQuantity > 0);
  const ranked = [...(withStock.length ? withStock : sources)].sort(compareStockSources(preferredId));
  return ranked[0]?.productData;
};

const withCheckoutCancelParams = (cancelUrl: string, orderId: string): string => {
  const [base, hash] = cancelUrl.split("#");
  const joiner = base.includes("?") ? "&" : "?";
  const next = `${base}${joiner}cs={CHECKOUT_SESSION_ID}&order_id=${encodeURIComponent(orderId)}`;
  return hash ? `${next}#${hash}` : next;
};

const expireStripeCheckoutSession = async (
  sessionId: string | null | undefined,
): Promise<Stripe.Checkout.Session | null> => {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const stripe = getVipStripeClient();
  try {
    return await stripe.checkout.sessions.expire(id);
  } catch {
    try {
      return await stripe.checkout.sessions.retrieve(id);
    } catch {
      return null;
    }
  }
};

const requireActiveDoc = async (
  collection: string,
  id: string,
  code: string,
  message: string,
): Promise<DocData & { id: string }> => {
  const doc = await col(collection).doc(id).get();
  if (!doc.exists || doc.data()?.activo === false || doc.data()?.enabled === false) {
    throw new ApiError(400, message, true, code);
  }
  return { id: doc.id, ...(doc.data() || {}) };
};

const resolveConfiguredSelection = (
  requested: string[],
  configured: unknown,
  label: string,
): Array<{ id: string; name: string; price: number; priceMinor: number; inventoryProductId?: string; inventoryQuantity?: number }> => {
  const rows = Array.isArray(configured) ? configured : [];
  const byId = new Map<string, DocData>();
  for (const row of rows) {
    if (row && typeof row === "object" && typeof (row as DocData).id === "string") {
      byId.set(String((row as DocData).id), row as DocData);
    }
  }
  const unique = [...new Set(requested)];
  return unique.map((selectionId) => {
    const row = byId.get(selectionId);
    if (!row || row.active === false) {
      throw new ApiError(400, `${label} no disponible: ${selectionId}`, true, "VIP_PRODUCT_DISABLED");
    }
    const price = Number(row.price ?? row.priceExtra ?? 0);
    if (!Number.isFinite(price) || price < 0) {
      throw new ApiError(500, "Configuración de precio VIP inválida", false, "VIP_INVALID_CONFIG");
    }
    return {
      id: selectionId,
      name: String(row.name ?? row.nombre ?? selectionId),
      price: minorToMoney(moneyToMinor(price)),
      priceMinor: moneyToMinor(price),
      ...(typeof row.inventoryProductId === "string"
        ? { inventoryProductId: row.inventoryProductId }
        : {}),
      ...(Number(row.inventoryQuantity) > 0
        ? { inventoryQuantity: Number(row.inventoryQuantity) }
        : {}),
    };
  });
};

const mergeDraws = (draws: ResolvedStockDraw[]): ResolvedStockDraw[] => {
  const merged = new Map<string, ResolvedStockDraw>();
  for (const draw of draws) {
    const key = `${draw.inventoryId}:${draw.productId}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += draw.quantity;
    else merged.set(key, { ...draw });
  }
  return [...merged.values()];
};

const resolveCheckout = async (input: VipCheckoutInput): Promise<ResolvedCheckout> => {
  const context = await getServiceContext();
  const zona = input.delivery.zona.trim();
  const palco = input.delivery.palco.trim();
  const nivel = normalizeVipFloor(zona, String(input.delivery.nivel || ""));
  if (!zona || !palco || !nivel) {
    throw new ApiError(400, "Indica zona, palco y piso para la entrega.", true, "VIP_INVALID_LOCATION");
  }

  const items: VipOrderItemSnapshot[] = [];
  const draws: ResolvedStockDraw[] = [];
  const fulfillmentMap = new Map<string, VipOrder["fulfillments"][number]>();

  for (const [index, requested] of input.items.entries()) {
    const product = await requireActiveDoc(
      COLLECTIONS.PRODUCTS,
      requested.productId,
      "VIP_PRODUCT_NOT_FOUND",
      "Uno o más productos no existen.",
    );
    const concessionId = String(product.concesion_id || product.concesionId || "");
    if (!concessionId) {
      throw new ApiError(400, "Uno o más productos no están habilitados para servicio a palcos.", true, "VIP_PRODUCT_DISABLED");
    }
    const productConfig = await loadOptionalProductConfig(requested.productId, concessionId);
    const concession = await requireActiveDoc(
      COLLECTIONS.CONCESIONES,
      concessionId,
      "VIP_PRODUCT_DISABLED",
      "La concesión del producto no está activa.",
    );
    const options = resolveConfiguredSelection(requested.selectedOptions, productConfig.options, "Opción");
    const extras = resolveConfiguredSelection(requested.extras, productConfig.extras, "Extra");
    const addOnDraws = [...options, ...extras]
      .filter((addOn) => addOn.inventoryProductId)
      .map((addOn) => ({
        productId: String(addOn.inventoryProductId),
        quantity: (addOn.inventoryQuantity || 1) * requested.quantity,
      }));
    const source = await pickStockSource(concessionId, requested.productId, [
      { productId: requested.productId, quantity: requested.quantity },
      ...addOnDraws,
    ]);
    const sucursalId = source.sucursalId;
    const inventoryId = source.inventory.id;
    const inventoryProductData = source.productData;

    const configuredPrice = Number(inventoryProductData?.precio_jornada ?? product.precio);
    if (!Number.isFinite(configuredPrice) || configuredPrice < 0) {
      throw new ApiError(500, "El producto tiene un precio inválido.", false, "VIP_INVALID_CONFIG");
    }
    const unitPriceMinor = moneyToMinor(configuredPrice) +
      [...options, ...extras].reduce((sum, row) => sum + row.priceMinor, 0);
    const lineTotalMinor = unitPriceMinor * requested.quantity;
    const itemId = `${requested.productId}-${index + 1}`;
    const snapshot: VipOrderItemSnapshot = {
      id: itemId,
      productId: requested.productId,
      concessionId,
      inventoryId,
      sucursalId,
      name: String(product.nombre || requested.productId),
      quantity: requested.quantity,
      unitPrice: minorToMoney(unitPriceMinor),
      unitPriceMinor,
      selectedOptions: options.map(({ id, name, price, priceMinor }) => ({ id, name, price, priceMinor })),
      extras: extras.map(({ id, name, price, priceMinor }) => ({ id, name, price, priceMinor })),
      notes: requested.notes || null,
      lineTotal: minorToMoney(lineTotalMinor),
      lineTotalMinor,
    };
    items.push(snapshot);
    draws.push({ inventoryId, sucursalId, concessionId, productId: requested.productId, quantity: requested.quantity });
    for (const addOn of addOnDraws) {
      draws.push({
        inventoryId,
        sucursalId,
        concessionId,
        productId: addOn.productId,
        quantity: addOn.quantity,
      });
    }

    const fulfillmentKey = `${concessionId}:${sucursalId}`;
    let fulfillment = fulfillmentMap.get(fulfillmentKey);
    if (!fulfillment) {
      fulfillment = {
        id: fulfillmentKey,
        concessionId,
        concessionName: String(concession.nombre || concessionId),
        sucursalId,
        inventoryId,
        itemIds: [],
        status: VipOrderStatus.PENDING_PAYMENT,
        subtotal: 0,
        subtotalMinor: 0,
      };
      fulfillmentMap.set(fulfillmentKey, fulfillment);
    }
    fulfillment.itemIds.push(itemId);
    fulfillment.subtotalMinor += lineTotalMinor;
    fulfillment.subtotal = minorToMoney(fulfillment.subtotalMinor);
  }

  const subtotalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  const configuredServiceFeeMinor = context.service.serviceFeeMinor;
  const fallbackServiceFeeMinor = moneyToMinor(Number(process.env.VIP_SERVICE_FEE || 20));
  const serviceFeeMinor = configuredServiceFeeMinor !== undefined
    ? Number(configuredServiceFeeMinor)
    : fallbackServiceFeeMinor;
  if (!Number.isInteger(serviceFeeMinor) || serviceFeeMinor < 0) {
    throw new ApiError(503, "El cargo de servicio no está configurado correctamente.", true, "VIP_NOT_CONFIGURED");
  }
  const tipMinor = moneyToMinor(input.tip);
  return {
    context,
    delivery: {
      locationId: null,
      zonaId: "",
      zona,
      palco,
      nivel,
      notes: input.delivery.notes || null,
    },
    items,
    fulfillments: [...fulfillmentMap.values()],
    draws: mergeDraws(draws),
    subtotalMinor,
    serviceFeeMinor,
    tipMinor,
    totalMinor: subtotalMinor + serviceFeeMinor + tipMinor,
  };
};

const eventPayload = (
  eventType: string,
  previousStatus: VipOrderStatus | null,
  newStatus: VipOrderStatus,
  actor: Actor,
  metadata?: Record<string, unknown>,
) => ({
  eventType,
  previousStatus,
  newStatus,
  actorId: actor.actorId,
  actorRole: actor.actorRole,
  timestamp: FieldValue.serverTimestamp(),
  metadata: metadata || {},
});

const orderEventRef = (orderId: string) =>
  orderCol().doc(orderId).collection(SUBCOLLECTIONS.EVENTS).doc();

const createStripeSession = async (
  order: VipOrder,
  idempotencyKey: string,
  returnUrls = resolveVipReturnUrls(),
) => {
  const stripe = getVipStripeClient();
  const expiresAt = Math.floor(order.reservationExpiresAt.toMillis() / 1000);
  const metadata = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    source: "VIP",
    fecha: order.fecha,
    jornadaId: order.jornadaId,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: order.customer.email,
    success_url: returnUrls.successUrl,
    cancel_url: withCheckoutCancelParams(returnUrls.cancelUrl, order.id),
    expires_at: expiresAt,
    locale: "es",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: order.currency,
        unit_amount: order.totalMinor,
        product_data: {
          name: `Pedido Palcos ${order.orderNumber}`,
          description: "Entrega a palco · Club León",
          metadata,
        },
      },
    }],
    metadata,
    payment_intent_data: { metadata },
  }, { idempotencyKey: `vip_checkout_${sha256(idempotencyKey).slice(0, 48)}` });
  if (!session.url) {
    throw new ApiError(502, "Stripe no devolvió una URL de checkout.", true, "VIP_PAYMENT_FAILED");
  }
  return session;
};

const loadOrder = async (orderId: string): Promise<VipOrder> => {
  const doc = await orderCol().doc(orderId).get();
  if (!doc.exists) {
    throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
  }
  return doc.data() as VipOrder;
};

export const createCheckout = async (
  input: VipCheckoutInput,
  idempotencyKey: string,
  returnOrigin?: string,
) => {
  if (!idempotencyKey || idempotencyKey.trim().length < 8 || idempotencyKey.length > 255) {
    throw new ApiError(400, "Idempotency-Key debe tener entre 8 y 255 caracteres.", true, "VIP_INVALID_IDEMPOTENCY_KEY");
  }
  const requestHash = sha256(JSON.stringify(input));
  const idemRef = col(COLLECTIONS.VIP_IDEMPOTENCY).doc(sha256(`checkout:${idempotencyKey}`));
  const priorIdempotency = await idemRef.get();
  if (priorIdempotency.exists) {
    if (priorIdempotency.data()?.requestHash !== requestHash) {
      throw new ApiError(409, "Idempotency-Key ya fue usada con otro checkout.", true, "VIP_IDEMPOTENCY_CONFLICT");
    }
    const priorOrder = await loadOrder(String(priorIdempotency.data()?.orderId));
    if (priorOrder.payment.checkoutSessionId) {
      const priorSession = await getVipStripeClient().checkout.sessions.retrieve(priorOrder.payment.checkoutSessionId);
      return {
        orderId: priorOrder.id,
        orderNumber: priorOrder.orderNumber,
        checkoutUrl: priorSession.url,
        checkoutSessionId: priorSession.id,
        trackingToken: buildTrackingToken(priorOrder.id),
        total: priorOrder.total,
        currency: priorOrder.currency,
      };
    }
  }
  const resolved = await resolveCheckout(input);
  const orderRef = orderCol().doc();
  const currency = getVipCurrency();
  const expiresAt = Timestamp.fromMillis(Date.now() + getVipReservationTtlMinutes() * 60_000);
  let selectedOrderId = orderRef.id;

  await firestorePos.runTransaction(async (tx) => {
    const idemDoc = await tx.get(idemRef);
    if (idemDoc.exists) {
      if (idemDoc.data()?.requestHash !== requestHash) {
        throw new ApiError(409, "Idempotency-Key ya fue usada con otro checkout.", true, "VIP_IDEMPOTENCY_CONFLICT");
      }
      selectedOrderId = String(idemDoc.data()?.orderId);
      return;
    }
    const serviceDoc = await tx.get(resolved.context.serviceRef);
    const latestService = serviceDoc.exists
      ? serviceDoc.data() || {}
      : { enabled: true, acceptingOrders: true, activeOrderCount: 0 };
    assertVipServiceOpen(latestService);
    assertVipCapacity(latestService);

    const uniqueInventoryIds = [...new Set(resolved.draws.map((draw) => draw.inventoryId))];
    const inventoryHeaders = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const inventoryId of uniqueInventoryIds) {
      const header = await tx.get(col(COLLECTIONS.INVENTARIOS).doc(inventoryId));
      if (!header.exists || !isOpenInventoryHeader(header.data())) {
        throw new ApiError(
          409,
          "El inventario de la jornada activa ya no está disponible.",
          true,
          "VIP_OUT_OF_STOCK",
        );
      }
      inventoryHeaders.set(inventoryId, header);
    }

    const stockRefs = resolved.draws.map((draw) =>
      col(COLLECTIONS.INVENTARIOS).doc(draw.inventoryId)
        .collection(SUBCOLLECTIONS.PRODUCTOS).doc(draw.productId));
    const stockDocs: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const ref of stockRefs) stockDocs.push(await tx.get(ref));
    for (const [index, draw] of resolved.draws.entries()) {
      const stockDoc = stockDocs[index];
      if (!stockDoc.exists) {
        throw new ApiError(409, "Uno o más productos no tienen inventario.", true, "VIP_OUT_OF_STOCK");
      }
      const current = Number(stockDoc.data()?.cantidad_final ?? stockDoc.data()?.cantidad_inicial ?? 0);
      reserveVipStock(current, draw.quantity);
    }

    const trackingToken = buildTrackingToken(orderRef.id);
    const now = Timestamp.now();
    const order: VipOrder = {
      id: orderRef.id,
      orderNumber: `PALCO-${resolved.context.fecha.replace(/-/g, "")}-${orderRef.id.slice(0, 6).toUpperCase()}`,
      fecha: resolved.context.fecha,
      jornadaId: resolved.context.fecha,
      matchId: resolved.context.fecha,
      customer: {
        name: input.customer.name,
        email: input.customer.email.toLowerCase(),
        phone: input.customer.phone || null,
      },
      delivery: resolved.delivery,
      items: resolved.items,
      fulfillments: resolved.fulfillments,
      concessionIds: [...new Set(resolved.items.map((item) => item.concessionId))],
      sucursalIds: [...new Set(resolved.items.map((item) => item.sucursalId))],
      subtotal: minorToMoney(resolved.subtotalMinor),
      subtotalMinor: resolved.subtotalMinor,
      serviceFee: minorToMoney(resolved.serviceFeeMinor),
      serviceFeeMinor: resolved.serviceFeeMinor,
      tip: minorToMoney(resolved.tipMinor),
      tipMinor: resolved.tipMinor,
      total: minorToMoney(resolved.totalMinor),
      totalMinor: resolved.totalMinor,
      currency,
      payment: {
        status: VipPaymentStatus.PENDING,
        provider: "STRIPE",
        checkoutSessionId: null,
        paymentIntentId: null,
        refundId: null,
        amountMinor: resolved.totalMinor,
        currency,
      },
      status: VipOrderStatus.PENDING_PAYMENT,
      runner: null,
      runnerId: null,
      trackingTokenHash: sha256(trackingToken),
      reservationExpiresAt: expiresAt,
      capacityReleased: false,
      inventoryConfirmed: false,
      salesRecorded: false,
      source: "VIP",
      channel: "VIP_DELIVERY",
      timestamps: {
        createdAt: now,
        paymentStartedAt: now,
        paidAt: null,
        acceptedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        refundedAt: null,
      },
      createdAt: now,
      updatedAt: now,
    };
    tx.create(orderRef, order);
    tx.create(idemRef, {
      operation: "VIP_CHECKOUT",
      idempotencyKeyHash: sha256(idempotencyKey),
      requestHash,
      orderId: orderRef.id,
      createdAt: now,
      expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
    });
    tx.set(resolved.context.serviceRef, {
      fecha: resolved.context.fecha,
      enabled: latestService.enabled !== false,
      acceptingOrders: latestService.acceptingOrders !== false,
      activeOrderCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
      ...(serviceDoc.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    for (const [index, draw] of resolved.draws.entries()) {
      const stockRef = stockRefs[index];
      const current = Number(stockDocs[index].data()?.cantidad_final ?? stockDocs[index].data()?.cantidad_inicial ?? 0);
      const next = reserveVipStock(current, draw.quantity);
      tx.update(stockRef, { cantidad_final: next, updatedAt: FieldValue.serverTimestamp() });
      const reservationId = sha256(`${orderRef.id}:${draw.inventoryId}:${draw.productId}`);
      const inventoryHeader = inventoryHeaders.get(draw.inventoryId)?.data() || {};
      const jornadaFecha = toIsoBusinessDate(inventoryHeader.jornada_fecha) || resolved.context.fecha;
      tx.create(col(COLLECTIONS.VIP_RESERVATIONS).doc(reservationId), {
        id: reservationId,
        orderId: orderRef.id,
        fecha: resolved.context.fecha,
        jornadaId: resolved.context.fecha,
        jornadaFecha,
        jornadaNumero: Number(inventoryHeader.jornada_numero || 0),
        inventoryId: draw.inventoryId,
        sucursalId: draw.sucursalId,
        concessionId: draw.concessionId,
        productId: draw.productId,
        quantity: draw.quantity,
        status: VipReservationStatus.ACTIVE,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      tx.create(
        col(COLLECTIONS.INVENTARIOS).doc(draw.inventoryId)
          .collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(),
        {
          tipo: "RESERVA_VIP",
          producto_id: draw.productId,
          cantidad: -draw.quantity,
          cantidad_anterior: current,
          cantidad_nueva: next,
          sucursal_id: draw.sucursalId,
          vipOrderId: orderRef.id,
          motivo: "Reserva temporal checkout palcos",
          createdAt: FieldValue.serverTimestamp(),
        },
      );
    }
    tx.create(orderEventRef(orderRef.id), eventPayload(
      "ORDER_CREATED",
      null,
      VipOrderStatus.PENDING_PAYMENT,
      { actorId: null, actorRole: "GUEST" },
    ));
    tx.create(orderEventRef(orderRef.id), eventPayload(
      "PAYMENT_STARTED",
      VipOrderStatus.PENDING_PAYMENT,
      VipOrderStatus.PENDING_PAYMENT,
      { actorId: null, actorRole: "GUEST" },
    ));
  });

  let order = await loadOrder(selectedOrderId);
  if (order.status !== VipOrderStatus.PENDING_PAYMENT || order.capacityReleased) {
    throw new ApiError(409, "Este checkout ya no puede reintentarse.", true, "VIP_PAYMENT_FAILED");
  }
  if (!order.payment.checkoutSessionId) {
    try {
      const session = await createStripeSession(order, idempotencyKey, resolveVipReturnUrls(returnOrigin));
      await orderCol().doc(order.id).set({
        "payment.checkoutSessionId": session.id,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      order = await loadOrder(order.id);
      console.info("vip_checkout_created", {
        orderId: order.id,
        orderNumber: order.orderNumber,
        stripeSessionId: session.id,
        fecha: order.fecha,
        action: "checkout_created",
        returnOrigin: returnOrigin || null,
        successUrl: session.success_url,
      });
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        checkoutUrl: session.url,
        checkoutSessionId: session.id,
        trackingToken: buildTrackingToken(order.id),
        total: order.total,
        currency: order.currency,
      };
    } catch (error) {
      await releaseReservations(order.id, VipOrderStatus.PAYMENT_FAILED, VipPaymentStatus.FAILED, "Stripe checkout creation failed");
      throw error instanceof ApiError
        ? error
        : new ApiError(502, "No fue posible iniciar el pago.", true, "VIP_PAYMENT_FAILED");
    }
  }
  const session = await getVipStripeClient().checkout.sessions.retrieve(order.payment.checkoutSessionId);
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    checkoutUrl: session.url,
    checkoutSessionId: session.id,
    trackingToken: buildTrackingToken(order.id),
    total: order.total,
    currency: order.currency,
  };
};

const reservationsForOrder = async (orderId: string) =>
  col(COLLECTIONS.VIP_RESERVATIONS).where("orderId", "==", orderId).get();

const releaseReservations = async (
  orderId: string,
  targetStatus: VipOrderStatus,
  paymentStatus: VipPaymentStatus,
  reason: string,
  actor: Actor = { actorId: null, actorRole: "SYSTEM" },
): Promise<void> => {
  const reservations = await reservationsForOrder(orderId);
  const orderRef = orderCol().doc(orderId);
  await firestorePos.runTransaction(async (tx) => {
    const orderDoc = await tx.get(orderRef);
    if (!orderDoc.exists) return;
    const order = orderDoc.data() as VipOrder;
    if (order.payment.status === VipPaymentStatus.PAID ||
        order.payment.status === VipPaymentStatus.REFUNDED ||
        order.payment.status === VipPaymentStatus.REFUND_PENDING ||
        order.payment.status === VipPaymentStatus.PARTIALLY_REFUNDED) {
      return;
    }
    const activeDocs: Array<{
      doc: FirebaseFirestore.DocumentSnapshot;
      stock: FirebaseFirestore.DocumentSnapshot | null;
      restoreStock: boolean;
    }> = [];
    const inventoryHeaders = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    const activeReservations: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const reservationDoc of reservations.docs) {
      const latest = await tx.get(reservationDoc.ref);
      if (latest.data()?.status !== VipReservationStatus.ACTIVE) continue;
      activeReservations.push(latest);
    }
    for (const reservation of activeReservations) {
      const inventoryId = String(reservation.data()?.inventoryId || "");
      if (!inventoryId || inventoryHeaders.has(inventoryId)) continue;
      inventoryHeaders.set(inventoryId, await tx.get(col(COLLECTIONS.INVENTARIOS).doc(inventoryId)));
    }
    for (const reservation of activeReservations) {
      const data = reservation.data() || {};
      const inventoryId = String(data.inventoryId || "");
      const restoreStock = isOpenInventoryHeader(inventoryHeaders.get(inventoryId)?.data());
      const stock = restoreStock
        ? await tx.get(
          col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
            .collection(SUBCOLLECTIONS.PRODUCTOS).doc(String(data.productId)),
        )
        : null;
      activeDocs.push({ doc: reservation, stock, restoreStock });
    }
    const serviceRef = orderServiceRef(order);
    const serviceDoc = order.capacityReleased ? null : await tx.get(serviceRef);
    for (const pair of activeDocs) {
      const data = pair.doc.data() || {};
      const quantity = Number(data.quantity || 0);
      if (pair.restoreStock && pair.stock) {
        const stockRef = pair.stock.ref;
        const current = Number(pair.stock.data()?.cantidad_final ?? pair.stock.data()?.cantidad_inicial ?? 0);
        const restored = releaseVipStock(current, quantity);
        tx.update(stockRef, { cantidad_final: restored, updatedAt: FieldValue.serverTimestamp() });
        tx.create(
          col(COLLECTIONS.INVENTARIOS).doc(String(data.inventoryId))
            .collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(),
          {
            tipo: "LIBERACION_RESERVA_VIP",
            producto_id: data.productId,
            cantidad: quantity,
            cantidad_anterior: current,
            cantidad_nueva: restored,
            sucursal_id: data.sucursalId,
            vipOrderId: orderId,
            motivo: reason,
            createdAt: FieldValue.serverTimestamp(),
          },
        );
      }
      tx.update(pair.doc.ref, {
        status: VipReservationStatus.RELEASED,
        reason,
        restoredToInventory: pair.restoreStock,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (!order.capacityReleased && serviceDoc?.exists) {
      tx.update(serviceRef, {
        activeOrderCount: Math.max(0, activeOrderCount(serviceDoc.data() || {}) - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(orderRef, {
      status: targetStatus,
      "payment.status": paymentStatus,
      capacityReleased: true,
      [`timestamps.${targetStatus === VipOrderStatus.CANCELLED ? "cancelledAt" : "paymentFailedAt"}`]: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(orderEventRef(orderId), eventPayload(
      targetStatus === VipOrderStatus.CANCELLED ? "ORDER_CANCELLED" : "PAYMENT_FAILED",
      order.status,
      targetStatus,
      actor,
      { reason },
    ));
  });
  console.info("vip_inventory_reservations_released", {
    orderId,
    action: "release_reservations",
    status: targetStatus,
    reservationCount: reservations.size,
  });
};

const finalizePaidOrder = async (
  orderId: string,
  eventId: string,
  paymentIntentId: string | null,
  checkoutSessionId: string | null,
  receivedAmountMinor: number | null,
  currency: string | null,
): Promise<void> => {
  const orderRef = orderCol().doc(orderId);
  const reservations = await reservationsForOrder(orderId);
  const result = await firestorePos.runTransaction(async (tx): Promise<"DONE" | "ALREADY_DONE" | "REFUND_REQUIRED"> => {
    const orderDoc = await tx.get(orderRef);
    if (!orderDoc.exists) throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
    const order = orderDoc.data() as VipOrder;
    if ([
      VipPaymentStatus.PAID,
      VipPaymentStatus.REFUND_PENDING,
      VipPaymentStatus.REFUNDED,
      VipPaymentStatus.PARTIALLY_REFUNDED,
    ].includes(order.payment.status)) return "ALREADY_DONE";
    if (receivedAmountMinor === null || receivedAmountMinor !== order.totalMinor) {
      throw new ApiError(409, "El monto pagado no coincide con la orden.", true, "VIP_PAYMENT_AMOUNT_MISMATCH");
    }
    if (!currency || currency.toLowerCase() !== order.currency.toLowerCase()) {
      throw new ApiError(409, "La moneda pagada no coincide con la orden.", true, "VIP_PAYMENT_AMOUNT_MISMATCH");
    }
    const reservationDocs: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const reservation of reservations.docs) reservationDocs.push(await tx.get(reservation.ref));
    const inventoryHeaders = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const reservation of reservationDocs) {
      const inventoryId = String(reservation.data()?.inventoryId || "");
      if (!inventoryId || inventoryHeaders.has(inventoryId)) continue;
      inventoryHeaders.set(inventoryId, await tx.get(col(COLLECTIONS.INVENTARIOS).doc(inventoryId)));
    }
    // Firestore exige todas las lecturas antes de cualquier escritura.
    const stockDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const reservation of reservationDocs) {
      const data = reservation.data() || {};
      if (data.status !== VipReservationStatus.ACTIVE) continue;
      const inventoryId = String(data.inventoryId || "");
      const productId = String(data.productId || "");
      if (!inventoryId || !productId) continue;
      const stockKey = `${inventoryId}/${productId}`;
      if (stockDocs.has(stockKey)) continue;
      stockDocs.set(
        stockKey,
        await tx.get(
          col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
            .collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId),
        ),
      );
    }
    const now = Timestamp.now();
    const usesInventory = order.items.some((item) => Boolean(item.inventoryId));
    const reservationUnavailable = usesInventory && (
      reservationDocs.length === 0 ||
      reservationDocs.some((reservation) =>
        ![VipReservationStatus.ACTIVE, VipReservationStatus.CONFIRMED].includes(reservation.data()?.status)) ||
      reservationDocs.some((reservation) =>
        !isOpenInventoryHeader(inventoryHeaders.get(String(reservation.data()?.inventoryId || ""))?.data()))
    );
    if (reservationUnavailable) {
      tx.update(orderRef, {
        status: VipOrderStatus.CANCELLED,
        "payment.status": VipPaymentStatus.PAID,
        ...(paymentIntentId ? { "payment.paymentIntentId": paymentIntentId } : {}),
        ...(checkoutSessionId ? { "payment.checkoutSessionId": checkoutSessionId } : {}),
        "timestamps.paidAt": now,
        "timestamps.cancelledAt": now,
        updatedAt: now,
      });
      tx.create(orderEventRef(orderId), eventPayload(
        "PAYMENT_CONFIRMED",
        order.status,
        VipOrderStatus.PAID,
        { actorId: eventId, actorRole: "STRIPE" },
        { paymentIntentId, checkoutSessionId, reservationUnavailable: true },
      ));
      tx.create(orderEventRef(orderId), eventPayload(
        "ORDER_CANCELLED",
        VipOrderStatus.PAID,
        VipOrderStatus.CANCELLED,
        { actorId: eventId, actorRole: "STRIPE" },
        { reason: "inventory_reservation_unavailable" },
      ));
      return "REFUND_REQUIRED";
    }
    for (const reservation of reservationDocs) {
      if (reservation.data()?.status === VipReservationStatus.ACTIVE) {
        tx.update(reservation.ref, { status: VipReservationStatus.CONFIRMED, updatedAt: now });
        const data = reservation.data() || {};
        const quantity = Number(data.quantity || 0);
        const inventoryId = String(data.inventoryId || "");
        const productId = String(data.productId || "");
        const stockDoc = stockDocs.get(`${inventoryId}/${productId}`);
        const current = Number(
          stockDoc?.data()?.cantidad_final ?? stockDoc?.data()?.cantidad_inicial ?? 0,
        );
        tx.create(
          col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
            .collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(),
          {
            tipo: "VENTA",
            producto_id: data.productId,
            cantidad: -quantity,
            // En VIP el stock ya se decrementó durante la reserva (RESERVA_VIP).
            // Al confirmar pago no se vuelve a tocar el inventario, pero la bitácora
            // debe reflejar correctamente el "antes" y "después" conceptual.
            cantidad_anterior: current + quantity,
            cantidad_nueva: current,
            sucursal_id: data.sucursalId,
            ventaId: order.id,
            motivo: "Reserva VIP confirmada por pago Stripe",
            createdAt: now,
          },
        );
      }
    }
    for (const fulfillment of order.fulfillments) {
      const saleId = vipSaleDocId(order.id, fulfillment, order.fulfillments);
      const saleRef = col(COLLECTIONS.COMPROBANTES_VENTA).doc(saleId);
      tx.set(saleRef, {
        ventaId: saleId,
        vipOrderId: order.id,
        vipOrderNumber: order.orderNumber,
        concesionId: fulfillment.concessionId,
        sucursalId: fulfillment.sucursalId,
        inventarioId: fulfillment.inventoryId,
        jornadaId: order.jornadaId,
        metodoPago: "tarjeta",
        source: "VIP",
        channel: "VIP_DELIVERY",
        total: fulfillment.subtotal,
        montoTarjeta: fulfillment.subtotal,
        vipOrderTotal: order.total,
        paymentIntentId,
        cajaId: null,
        cajaNombre: "VIP",
        idUser: null,
        cajeroNombre: "VIP Stripe",
        lineasVenta: order.items
          .filter((row) => fulfillment.itemIds.includes(row.id))
          .map((item) => ({
            producto: item.productId,
            cantidad: item.quantity,
            precio_actual: item.unitPrice,
            subtotal: item.lineTotal,
          })),
        fecha: now,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
      for (const item of order.items.filter((row) => fulfillment.itemIds.includes(row.id))) {
        tx.set(saleRef.collection(SUBCOLLECTIONS.DETALLE).doc(item.id), {
          producto: item.productId,
          nombre: item.name,
          cantidad: item.quantity,
          precio_actual: item.unitPrice,
          subtotal: item.lineTotal,
          selectedOptions: item.selectedOptions,
          extras: item.extras,
          notes: item.notes,
        }, { merge: true });
      }
    }
    tx.update(orderRef, {
      status: VipOrderStatus.RECEIVED,
      "payment.status": VipPaymentStatus.PAID,
      ...(paymentIntentId ? { "payment.paymentIntentId": paymentIntentId } : {}),
      ...(checkoutSessionId ? { "payment.checkoutSessionId": checkoutSessionId } : {}),
      inventoryConfirmed: true,
      salesRecorded: true,
      fulfillments: order.fulfillments.map((row) => ({ ...row, status: VipOrderStatus.RECEIVED })),
      "timestamps.paidAt": now,
      "timestamps.receivedAt": now,
      updatedAt: now,
    });
    tx.create(orderEventRef(orderId), eventPayload(
      "PAYMENT_CONFIRMED",
      order.status,
      VipOrderStatus.PAID,
      { actorId: eventId, actorRole: "STRIPE" },
      { paymentIntentId, checkoutSessionId },
    ));
    tx.create(orderEventRef(orderId), eventPayload(
      "STATUS_CHANGED",
      VipOrderStatus.PAID,
      VipOrderStatus.RECEIVED,
      { actorId: eventId, actorRole: "STRIPE" },
    ));
    return "DONE";
  });
  if (result === "REFUND_REQUIRED") {
    await performRefund(
      orderId,
      "Pago recibido después de expirar la reserva de inventario",
      { actorId: eventId, actorRole: "STRIPE" },
    );
  } else if (result === "DONE") {
    console.info("vip_payment_finalized", {
      orderId,
      paymentIntentId,
      stripeEventId: eventId,
      action: "payment_confirmed",
      status: VipOrderStatus.RECEIVED,
    });
    try {
      const paidOrder = await loadOrder(orderId);
      await sendVipOrderPaidEmail(paidOrder);
    } catch (error) {
      console.error("[Brevo] sendVipOrderPaidEmail failed after payment", {
        orderId,
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
};

const stripeObjectMetadata = (
  object: Stripe.Checkout.Session | Stripe.PaymentIntent | Stripe.Charge,
) => object.metadata || {};

export const processStripeWebhook = async (rawBody: Buffer, signature: string) => {
  const stripe = getVipStripeClient();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, getVipStripeWebhookSecret());
  } catch {
    throw new ApiError(400, "Firma de webhook Stripe inválida.", true, "VIP_INVALID_WEBHOOK_SIGNATURE");
  }
  const eventRef = col(COLLECTIONS.VIP_STRIPE_EVENTS).doc(event.id);
  try {
    await eventRef.create({
      eventId: event.id,
      eventType: event.type,
      status: "PROCESSING",
      livemode: event.livemode,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    const existing = await eventRef.get();
    const existingData = existing.data() || {};
    if (existing.exists && ["PROCESSED", "IGNORED"].includes(String(existingData.status))) {
      return { duplicate: true, eventId: event.id, eventType: event.type };
    }
    const updatedAt = asMillis(existingData.updatedAt);
    if (existingData.status === "PROCESSING" && updatedAt !== null && Date.now() - updatedAt < 2 * 60_000) {
      throw new ApiError(409, "El evento Stripe ya está en proceso.", true, "VIP_WEBHOOK_IN_PROGRESS");
    }
    await eventRef.set({
      status: "PROCESSING",
      attemptCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  try {
    const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent | Stripe.Charge;
    let metadata = stripeObjectMetadata(object);
    if (event.type === "charge.refunded" && !metadata.orderId) {
      const charge = object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (paymentIntentId) {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        metadata = intent.metadata || {};
      }
    }
    const orderId = metadata.orderId;
    if (!orderId) {
      await eventRef.set({ status: "IGNORED", reason: "missing_order_id", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { duplicate: false, ignored: true, eventId: event.id, eventType: event.type };
    }
    if (event.type === "charge.refunded") {
      const charge = object as Stripe.Charge;
      const refund = charge.refunds?.data.find((row) => row.status === "succeeded") || charge.refunds?.data[0];
      await reconcileStripeRefund(
        orderId,
        refund?.id || `charge_${charge.id}`,
        Number(charge.amount_refunded || 0),
        { actorId: event.id, actorRole: "STRIPE" },
      );
    } else if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = object as Stripe.Checkout.Session;
      if (session.payment_status === "paid") {
        await finalizePaidOrder(
          orderId,
          event.id,
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || null,
          session.id,
          session.amount_total,
          session.currency,
        );
      }
    } else if (event.type === "payment_intent.succeeded") {
      const intent = object as Stripe.PaymentIntent;
      await finalizePaidOrder(orderId, event.id, intent.id, null, intent.amount_received, intent.currency);
    } else if (
      event.type === "checkout.session.async_payment_failed" ||
      event.type === "checkout.session.expired" ||
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled"
    ) {
      const order = await loadOrder(orderId);
      if (order.payment.status !== VipPaymentStatus.PAID) {
        await releaseReservations(
          orderId,
          VipOrderStatus.PAYMENT_FAILED,
          VipPaymentStatus.FAILED,
          event.type,
          { actorId: event.id, actorRole: "STRIPE" },
        );
      }
    } else {
      await eventRef.set({ status: "IGNORED", reason: "unsupported_event", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { duplicate: false, ignored: true, eventId: event.id, eventType: event.type };
    }
    await eventRef.set({ status: "PROCESSED", orderId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    console.info("vip_stripe_webhook_processed", {
      orderId,
      stripeEventId: event.id,
      action: event.type,
      status: "PROCESSED",
    });
    return { duplicate: false, eventId: event.id, eventType: event.type, orderId };
  } catch (error) {
    await eventRef.set({
      status: "ERROR",
      errorCode: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
};

export const confirmCheckoutSession = async (sessionId: string) => {
  const id = sessionId.trim();
  if (!id.startsWith("cs_") || id.length < 7 || id.length > 255) {
    throw new ApiError(400, "session_id de Stripe inválido.", true, "VIP_INVALID_REQUEST");
  }
  const session = await getVipStripeClient().checkout.sessions.retrieve(id);
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    throw new ApiError(404, "No hay una orden VIP ligada a esta sesión.", true, "VIP_ORDER_NOT_FOUND");
  }
  const order = await loadOrder(orderId);
  if (order.payment.checkoutSessionId && order.payment.checkoutSessionId !== session.id) {
    throw new ApiError(409, "La sesión no corresponde a esta orden.", true, "VIP_PAYMENT_FAILED");
  }
  if (session.payment_status === "paid") {
    await finalizePaidOrder(
      orderId,
      `session_confirm:${session.id}`,
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null,
      session.id,
      session.amount_total,
      session.currency,
    );
  }
  const latest = await loadOrder(orderId);
  return {
    orderId: latest.id,
    orderNumber: latest.orderNumber,
    status: latest.status,
    paymentStatus: latest.payment.status,
    paid: latest.payment.status === VipPaymentStatus.PAID,
  };
};

const paidFromStripeSession = (session: Stripe.Checkout.Session | null): boolean =>
  session?.payment_status === "paid";

const abandonResult = (order: VipOrder, released: boolean) => ({
  orderId: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  paymentStatus: order.payment.status,
  released,
  paid: order.payment.status === VipPaymentStatus.PAID,
});

export const abandonCheckout = async (input: VipAbandonCheckoutInput) => {
  const sessionId = String(input.sessionId || "").trim();
  const trackingToken = String(input.trackingToken || "").trim();
  let orderId = String(input.orderId || "").trim();

  let stripeSession: Stripe.Checkout.Session | null = null;
  if (sessionId) {
    stripeSession = await getVipStripeClient().checkout.sessions.retrieve(sessionId);
    const fromSession = String(stripeSession.metadata?.orderId || "").trim();
    if (!fromSession) {
      throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
    }
    if (orderId && orderId !== fromSession) {
      throw new ApiError(409, "La sesión no corresponde a esta orden.", true, "VIP_PAYMENT_FAILED");
    }
    orderId = fromSession;
  } else if (orderId && trackingToken) {
    if (!verifyTrackingToken(orderId, trackingToken)) {
      throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
    }
    const claimed = await loadOrder(orderId);
    if (claimed.trackingTokenHash !== sha256(trackingToken)) {
      throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
    }
  } else {
    throw new ApiError(400, "Indica la sesión de Stripe o el pedido con su token.", true, "VIP_INVALID_REQUEST");
  }

  const order = await loadOrder(orderId);
  if (sessionId && order.payment.checkoutSessionId && order.payment.checkoutSessionId !== sessionId) {
    throw new ApiError(409, "La sesión no corresponde a esta orden.", true, "VIP_PAYMENT_FAILED");
  }

  const finalizeFromSession = async (session: Stripe.Checkout.Session) => {
    await finalizePaidOrder(
      orderId,
      `session_abandon:${session.id}`,
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || null,
      session.id,
      session.amount_total,
      session.currency,
    );
  };

  if (paidFromStripeSession(stripeSession) || order.payment.status === VipPaymentStatus.PAID) {
    if (order.payment.status !== VipPaymentStatus.PAID && stripeSession) {
      await finalizeFromSession(stripeSession);
    }
    return abandonResult(await loadOrder(orderId), false);
  }

  if (
    order.capacityReleased ||
    order.status === VipOrderStatus.CANCELLED ||
    order.status === VipOrderStatus.PAYMENT_FAILED
  ) {
    return abandonResult(order, true);
  }

  const latestSession = await expireStripeCheckoutSession(sessionId || order.payment.checkoutSessionId);
  if (paidFromStripeSession(latestSession) && latestSession) {
    await finalizeFromSession(latestSession);
    return abandonResult(await loadOrder(orderId), false);
  }

  await releaseReservations(
    orderId,
    VipOrderStatus.CANCELLED,
    VipPaymentStatus.FAILED,
    "Checkout cancelado por el cliente",
    { actorId: null, actorRole: "GUEST" },
  );
  return abandonResult(await loadOrder(orderId), true);
};

const sucursalesForConcession = (
  concessionId: string,
  config: DocData | undefined,
  sucursales: Array<{ id: string; data: DocData }>,
): Array<{ id: string; data: DocData }> => {
  if (!concessionVipEnabled(config)) return [];
  return sucursales.filter(
    (row) => String(row.data.concesion_id || "") === concessionId && row.data.activo !== false,
  );
};

const newestOpenInventoryBySucursal = (
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
): Map<string, FirebaseFirestore.QueryDocumentSnapshot> => {
  const bySucursal = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const doc of docs) {
    if (!isOpenInventoryHeader(doc.data())) continue;
    const sucursalId = String(doc.data()?.sucursal_id || "");
    if (!sucursalId) continue;
    const list = bySucursal.get(sucursalId) || [];
    list.push(doc);
    bySucursal.set(sucursalId, list);
  }
  const newest = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const [sucursalId, list] of bySucursal) {
    const picked = pickPreferredOpenInventory(list);
    if (picked) newest.set(sucursalId, picked);
  }
  return newest;
};

const toCatalogProduct = (
  productDoc: FirebaseFirestore.DocumentSnapshot,
  concessionId: string,
  vip: DocData,
  inventoryProductData: DocData | undefined,
): DocData | null => {
  const product = productDoc.data() || {};
  if (product.activo === false) return null;
  if (vip.enabled === false || (vip.concessionId && String(vip.concessionId) !== concessionId)) {
    return null;
  }
  const price = Number(inventoryProductData?.precio_jornada ?? product.precio);
  if (!Number.isFinite(price) || price < 0) {
    throw new ApiError(503, "El catálogo VIP contiene un precio inválido.", true, "VIP_NOT_CONFIGURED");
  }
  const availableQuantity = inventoryProductData
    ? Number(inventoryProductData.cantidad_final ?? inventoryProductData.cantidad_inicial ?? 0)
    : 0;
  const normalizedProductImages = normalizeRecordImageUrls({
    id: productDoc.id,
    imagenes: Array.isArray(product.imagenes) ? product.imagenes : [],
  }).imagenes;
  return {
    id: productDoc.id,
    concessionId,
    name: String(product.nombre || productDoc.id),
    unit: String(product.unidad_medida || "pieza"),
    images: normalizedProductImages,
    price: minorToMoney(moneyToMinor(price)),
    currency: getVipCurrency(),
    available: Number.isFinite(availableQuantity) && availableQuantity > 0,
    options: resolveConfiguredSelection(
      Array.isArray(vip.options) ? vip.options.filter((row: DocData) => row?.active !== false).map((row: DocData) => String(row.id)) : [],
      vip.options,
      "Opción",
    ).map(({ id, name, price: optionPrice }) => ({ id, name, price: optionPrice })),
    extras: resolveConfiguredSelection(
      Array.isArray(vip.extras) ? vip.extras.filter((row: DocData) => row?.active !== false).map((row: DocData) => String(row.id)) : [],
      vip.extras,
      "Extra",
    ).map(({ id, name, price: extraPrice }) => ({ id, name, price: extraPrice })),
  };
};

const loadInventoryProductMaps = async (
  inventories: FirebaseFirestore.QueryDocumentSnapshot[],
): Promise<Map<string, Map<string, DocData>>> => {
  const maps = new Map<string, Map<string, DocData>>();
  if (inventories.length === 0) return maps;
  const snaps = await Promise.all(
    inventories.map((inventory) => inventory.ref.collection(SUBCOLLECTIONS.PRODUCTOS).get()),
  );
  inventories.forEach((inventory, index) => {
    const byProduct = new Map<string, DocData>();
    for (const doc of snaps[index].docs) {
      byProduct.set(doc.id, doc.data() || {});
    }
    maps.set(inventory.id, byProduct);
  });
  return maps;
};

const toCatalogConcession = (
  concessionId: string,
  concession: DocData,
  products: DocData[],
): DocData => {
  const normalizedConcessionImages = normalizeRecordImageUrls({
    id: concessionId,
    imagenes: Array.isArray(concession.imagenes) ? concession.imagenes : [],
  }).imagenes;
  return {
    id: concessionId,
    name: String(concession.nombre || concessionId),
    images: normalizedConcessionImages,
    type: concession.tipo === "CERVECERIA" ? "CERVECERIA" : "GENERAL",
    products,
  };
};

export const listCatalog = async () => {
  const started = Date.now();
  const [concessionSnap, configSnap, sucursalSnap, openInvSnap, productSnap, vipSnap] = await Promise.all([
    col(COLLECTIONS.CONCESIONES).get(),
    col(COLLECTIONS.VIP_CONCESSION_CONFIG).get(),
    col(COLLECTIONS.SUCURSALES).get(),
    col(COLLECTIONS.INVENTARIOS).where("activo", "==", true).get(),
    col(COLLECTIONS.PRODUCTS).get(),
    col(COLLECTIONS.VIP_PRODUCT_CONFIG).get(),
  ]);

  const configs = new Map(configSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
  const sucursales = sucursalSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  const inventoryBySucursal = newestOpenInventoryBySucursal(openInvSnap.docs);
  const usedInventories = [...new Map(
    [...inventoryBySucursal.values()].map((doc) => [doc.id, doc] as const),
  ).values()];
  const inventoryProducts = await loadInventoryProductMaps(usedInventories);
  const vipByProduct = new Map(vipSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
  const productsByConcession = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const doc of productSnap.docs) {
    const concessionId = String(doc.data()?.concesion_id || "");
    if (!concessionId) continue;
    const list = productsByConcession.get(concessionId) || [];
    list.push(doc);
    productsByConcession.set(concessionId, list);
  }

  const result: DocData[] = [];
  for (const concessionDoc of concessionSnap.docs) {
    if (!concessionDoc.exists || concessionDoc.data()?.activo === false) continue;
    const concessionSucursales = sucursalesForConcession(
      concessionDoc.id,
      configs.get(concessionDoc.id),
      sucursales,
    );
    if (!concessionSucursales.length) continue;
    const preferredId = preferredSucursalIdFrom(configs.get(concessionDoc.id), concessionSucursales);
    const products: DocData[] = [];
    for (const productDoc of productsByConcession.get(concessionDoc.id) || []) {
      const mapped = toCatalogProduct(
        productDoc,
        concessionDoc.id,
        vipByProduct.get(productDoc.id) || {},
        pickCatalogStockLine(
          productDoc.id,
          concessionSucursales,
          preferredId,
          inventoryBySucursal,
          inventoryProducts,
        ),
      );
      if (mapped) products.push(mapped);
    }
    if (products.length === 0) continue;
    result.push(toCatalogConcession(concessionDoc.id, concessionDoc.data() || {}, products));
  }
  console.info("vip_catalog_loaded", {
    action: "list_catalog",
    ms: Date.now() - started,
    concessions: result.length,
    products: result.reduce((sum, row) => sum + (Array.isArray(row.products) ? row.products.length : 0), 0),
  });
  return result;
};

export const getCatalogConcession = async (id: string) => {
  const concessionDoc = await col(COLLECTIONS.CONCESIONES).doc(id).get();
  if (!concessionDoc.exists || concessionDoc.data()?.activo === false) {
    throw new ApiError(404, "Concesión no encontrada.", true, "VIP_PRODUCT_NOT_FOUND");
  }
  const [configDoc, sucursalSnap, productSnap, openInvSnap] = await Promise.all([
    col(COLLECTIONS.VIP_CONCESSION_CONFIG).doc(id).get(),
    col(COLLECTIONS.SUCURSALES).where("concesion_id", "==", id).get(),
    col(COLLECTIONS.PRODUCTS).where("concesion_id", "==", id).get(),
    col(COLLECTIONS.INVENTARIOS).where("activo", "==", true).get(),
  ]);
  const concessionSucursales = sucursalesForConcession(
    id,
    configDoc.exists ? configDoc.data() : undefined,
    sucursalSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} })),
  );
  if (!concessionSucursales.length) {
    throw new ApiError(404, "Concesión no encontrada.", true, "VIP_PRODUCT_NOT_FOUND");
  }
  const preferredId = preferredSucursalIdFrom(
    configDoc.exists ? configDoc.data() : undefined,
    concessionSucursales,
  );
  const allowedSucursalIds = new Set(concessionSucursales.map((row) => row.id));
  const inventoryBySucursal = newestOpenInventoryBySucursal(
    openInvSnap.docs.filter((doc) => allowedSucursalIds.has(String(doc.data()?.sucursal_id || ""))),
  );
  const usedInventories = [...new Map(
    [...inventoryBySucursal.values()].map((doc) => [doc.id, doc] as const),
  ).values()];
  const [vipDocs, inventoryProducts] = await Promise.all([
    Promise.all(productSnap.docs.map((doc) => col(COLLECTIONS.VIP_PRODUCT_CONFIG).doc(doc.id).get())),
    loadInventoryProductMaps(usedInventories),
  ]);
  const products: DocData[] = [];
  productSnap.docs.forEach((productDoc, index) => {
    const mapped = toCatalogProduct(
      productDoc,
      id,
      vipDocs[index].exists ? vipDocs[index].data() || {} : {},
      pickCatalogStockLine(
        productDoc.id,
        concessionSucursales,
        preferredId,
        inventoryBySucursal,
        inventoryProducts,
      ),
    );
    if (mapped) products.push(mapped);
  });
  if (products.length === 0) {
    throw new ApiError(404, "Concesión no encontrada.", true, "VIP_PRODUCT_NOT_FOUND");
  }
  return toCatalogConcession(id, concessionDoc.data() || {}, products);
};

export const listLocations = async () => {
  const snap = await col(COLLECTIONS.VIP_LOCATIONS).where("activo", "==", true).get();
  const locations: DocData[] = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const zonaId = String(data.zonaId || "");
    const palco = String(data.palco || "");
    const nivel = String(data.nivel || "");
    const zone = zonaId ? await col(COLLECTIONS.ZONAS).doc(zonaId).get() : null;
    if (!zonaId || !palco || !nivel || !zone?.exists || zone.data()?.activo === false) {
      throw new ApiError(503, "El catálogo oficial de ubicaciones de palcos está incompleto.", true, "VIP_NOT_CONFIGURED");
    }
    locations.push({
      id: doc.id,
      zonaId,
      zona: String(zone.data()?.zona || zonaId),
      palco,
      nivel,
    });
  }
  return locations;
};

const publicTrackingOrder = (order: VipOrder) => ({
  id: order.id,
  orderNumber: order.orderNumber,
  fecha: order.fecha,
  jornadaId: order.jornadaId,
  customer: { name: order.customer.name, email: order.customer.email.replace(/(^.).*(@.*$)/, "$1***$2") },
  delivery: order.delivery,
  items: order.items,
  fulfillments: order.fulfillments,
  subtotal: order.subtotal,
  serviceFee: order.serviceFee,
  tip: order.tip,
  total: order.total,
  currency: order.currency,
  paymentStatus: order.payment.status,
  status: order.status,
  runner: order.runner,
  timestamps: Object.fromEntries(
    Object.entries(order.timestamps || {}).map(([key, value]) => [key, asIso(value)]),
  ),
  createdAt: asIso(order.createdAt),
  updatedAt: asIso(order.updatedAt),
});

export const getTracking = async (orderId: string, token: string) => {
  const order = await loadOrder(orderId);
  if (!verifyTrackingToken(orderId, token) || order.trackingTokenHash !== sha256(token)) {
    throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
  }
  return publicTrackingOrder(order);
};

export const listAdminOrders = async (filters: {
  status?: VipOrderStatus;
  fecha?: string;
  jornadaId?: string;
  zona: VipStadiumZone;
  concessionId?: string;
  sucursalId?: string;
  runnerId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}) => {
  if (filters.zona !== "Oriente" && filters.zona !== "Poniente") {
    throw new ApiError(400, "Indica la zona de esta Central (Oriente o Poniente).", true, "VIP_ZONE_REQUIRED");
  }
  const filterDimensions = [filters.concessionId, filters.sucursalId, filters.runnerId]
    .filter(Boolean).length;
  if (filterDimensions > 1) {
    throw new ApiError(
      400,
      "Combina status/fecha con un solo filtro operativo (concesión, sucursal o runner).",
      true,
      "VIP_INVALID_FILTERS",
    );
  }
  const fecha = filters.fecha || filters.jornadaId;
  let query: FirebaseFirestore.Query = orderCol();
  if (filters.status) query = query.where("status", "==", filters.status);
  if (fecha) query = query.where("fecha", "==", fecha);
  if (filters.concessionId) query = query.where("concessionIds", "array-contains", filters.concessionId);
  if (filters.sucursalId) query = query.where("sucursalIds", "array-contains", filters.sucursalId);
  if (filters.runnerId) query = query.where("runnerId", "==", filters.runnerId);
  if (filters.from) query = query.where("createdAt", ">=", Timestamp.fromDate(new Date(filters.from)));
  if (filters.to) query = query.where("createdAt", "<=", Timestamp.fromDate(new Date(filters.to)));
  query = query.orderBy("createdAt", "desc");
  if (filters.cursor) {
    const cursor = await orderCol().doc(filters.cursor).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  try {
    const snap = await query.limit(filters.limit).get();
    const data = snap.docs
      .map((doc) => doc.data() as VipOrder)
      .filter((row) => row.delivery?.zona === filters.zona);
    return {
      data,
      nextCursor: snap.size === filters.limit ? snap.docs[snap.docs.length - 1].id : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingIndex = message.includes("FAILED_PRECONDITION") || message.includes("requires an index");
    if (!missingIndex || !fecha) throw error;
    const fallback = await orderCol().where("fecha", "==", fecha).get();
    const rows = fallback.docs
      .map((doc) => doc.data() as VipOrder)
      .filter((row) => row.delivery?.zona === filters.zona)
      .sort((a, b) => (asMillis(b.createdAt) || 0) - (asMillis(a.createdAt) || 0))
      .slice(0, filters.limit);
    return {
      data: rows,
      nextCursor: null,
    };
  }
};

export const unlockCentralZone = (password: string, zona: VipStadiumZone) => {
  const expected = getVipCentralZonePassword();
  const received = createHash("sha256").update(String(password || "")).digest();
  const target = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(received, target)) {
    throw new ApiError(401, "Contraseña incorrecta.", true, "VIP_INVALID_ZONE_PASSWORD");
  }
  return { zona };
};

export const getAdminOrder = loadOrder;

export const transitionOrder = async (
  orderId: string,
  status: VipOrderStatus,
  actor: Actor,
  metadata?: Record<string, unknown>,
) => {
  const ref = orderCol().doc(orderId);
  const previousStatus = await firestorePos.runTransaction(async (tx): Promise<VipOrderStatus> => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
    const order = doc.data() as VipOrder;
    const autoOnTheWay = status === VipOrderStatus.ACCEPTED && order.status === VipOrderStatus.RECEIVED;
    const finalStatus = autoOnTheWay ? VipOrderStatus.ON_THE_WAY : status;
    if (order.status === finalStatus) return order.status;
    assertVipOrderTransition(order.status, status);
    if (autoOnTheWay) assertVipOrderTransition(VipOrderStatus.ACCEPTED, VipOrderStatus.ON_THE_WAY);
    if ([
      VipOrderStatus.PENDING_PAYMENT,
      VipOrderStatus.PAID,
      VipOrderStatus.PAYMENT_FAILED,
      VipOrderStatus.CANCELLED,
      VipOrderStatus.REFUNDED,
    ].includes(status)) {
      throw new ApiError(409, "Ese estado solo puede establecerlo el flujo de pago.", true, "VIP_INVALID_STATE_TRANSITION");
    }
    let capacityReleased = order.capacityReleased;
    const closesKitchen = isVipTerminalStatus(finalStatus)
      || finalStatus === VipOrderStatus.PREPARING
      || finalStatus === VipOrderStatus.ON_THE_WAY;
    if (!capacityReleased && closesKitchen) {
      const serviceRef = orderServiceRef(order);
      const serviceDoc = await tx.get(serviceRef);
      if (serviceDoc.exists) {
        tx.update(serviceRef, {
          activeOrderCount: Math.max(0, activeOrderCount(serviceDoc.data() || {}) - 1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      capacityReleased = true;
    }
    const timestampKey = finalStatus.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) + "At";
    tx.update(ref, {
      status: finalStatus,
      capacityReleased,
      fulfillments: order.fulfillments.map((row) => ({ ...row, status: finalStatus })),
      ...(autoOnTheWay ? { "timestamps.acceptedAt": FieldValue.serverTimestamp() } : {}),
      [`timestamps.${timestampKey}`]: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (autoOnTheWay) {
      tx.create(orderEventRef(orderId), eventPayload(
        "ORDER_ACCEPTED",
        order.status,
        VipOrderStatus.ACCEPTED,
        actor,
        metadata,
      ));
      tx.create(orderEventRef(orderId), eventPayload(
        "STATUS_CHANGED",
        VipOrderStatus.ACCEPTED,
        VipOrderStatus.ON_THE_WAY,
        actor,
        { ...metadata, autoDispatched: true },
      ));
    } else {
      tx.create(orderEventRef(orderId), eventPayload(
        status === VipOrderStatus.ACCEPTED ? "ORDER_ACCEPTED" : status === VipOrderStatus.DELIVERED ? "ORDER_DELIVERED" : "STATUS_CHANGED",
        order.status,
        finalStatus,
        actor,
        metadata,
      ));
    }
    return order.status;
  });
  const updated = await loadOrder(orderId);
  console.info("vip_order_status_changed", {
    orderId,
    orderNumber: updated.orderNumber,
    fecha: updated.fecha,
    actorId: actor.actorId,
    action: "status_changed",
    status: updated.status,
  });
  if (previousStatus !== VipOrderStatus.DELIVERED && updated.status === VipOrderStatus.DELIVERED) {
    try {
      await sendVipOrderDeliveredEmail(updated);
    } catch (error) {
      console.error("[Brevo] sendVipOrderDeliveredEmail failed after delivery", {
        orderId,
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
  return updated;
};

export const assignRunner = async (
  orderId: string,
  runner: { runnerId: string; name: string; phone?: string },
  actor: Actor,
) => {
  const ref = orderCol().doc(orderId);
  await firestorePos.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw new ApiError(404, "Orden no encontrada.", true, "VIP_ORDER_NOT_FOUND");
    const order = doc.data() as VipOrder;
    if (isVipTerminalStatus(order.status) || [
      VipOrderStatus.PENDING_PAYMENT,
      VipOrderStatus.PAID,
    ].includes(order.status)) {
      throw new ApiError(409, "No se puede asignar runner a una orden cerrada.", true, "VIP_INVALID_STATE_TRANSITION");
    }
    tx.update(ref, {
      runner: { id: runner.runnerId, name: runner.name, phone: runner.phone || null },
      runnerId: runner.runnerId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(orderEventRef(orderId), eventPayload("RUNNER_ASSIGNED", order.status, order.status, actor, { runnerId: runner.runnerId }));
  });
  const updated = await loadOrder(orderId);
  console.info("vip_runner_assigned", {
    orderId,
    orderNumber: updated.orderNumber,
    runnerId: runner.runnerId,
    action: "runner_assigned",
    status: updated.status,
  });
  return updated;
};

async function performRefund(
  orderId: string,
  reason: string,
  actor: Actor,
  existingRefund?: { id: string; amount: number },
) {
  const orderRef = orderCol().doc(orderId);
  const operationRef = col(COLLECTIONS.VIP_REFUND_OPERATIONS).doc(orderId);
  let order = await loadOrder(orderId);
  if (order.payment.status === VipPaymentStatus.REFUNDED) return order;
  if (![
    VipPaymentStatus.PAID,
    VipPaymentStatus.REFUND_PENDING,
    VipPaymentStatus.PARTIALLY_REFUNDED,
  ].includes(order.payment.status) ||
      !order.payment.paymentIntentId) {
    throw new ApiError(409, "La orden no tiene un pago Stripe reembolsable.", true, "VIP_REFUND_FAILED");
  }
  if ([VipOrderStatus.DELIVERED, VipOrderStatus.REFUNDED].includes(order.status)) {
    throw new ApiError(409, "La orden ya no puede reembolsarse.", true, "VIP_INVALID_STATE_TRANSITION");
  }
  await firestorePos.runTransaction(async (tx) => {
    const op = await tx.get(operationRef);
    if (!op.exists) {
      tx.create(operationRef, {
        orderId,
        status: "STARTED",
        previousStatus: order.status,
        reason,
        requestedBy: actor.actorId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(orderRef, {
        "payment.status": VipPaymentStatus.REFUND_PENDING,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
  let refund: Pick<Stripe.Refund, "id" | "amount">;
  if (existingRefund) {
    refund = existingRefund;
  } else {
    try {
      const refundedAmountMinor = Number(order.payment.refundedAmountMinor || 0);
      refund = await getVipStripeClient().refunds.create({
        payment_intent: order.payment.paymentIntentId,
        ...(refundedAmountMinor > 0 ? { amount: order.totalMinor - refundedAmountMinor } : {}),
        reason: "requested_by_customer",
        metadata: { orderId, source: "VIP", refundReason: reason.slice(0, 450) },
      }, { idempotencyKey: `vip_refund_${sha256(orderId).slice(0, 48)}` });
    } catch {
      const latestOperation = await operationRef.get();
      if (latestOperation.data()?.status === "COMPLETED") return loadOrder(orderId);
      await operationRef.set({ status: "ERROR", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await orderRef.set({ "payment.status": VipPaymentStatus.PAID, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new ApiError(502, "Stripe no pudo procesar el reembolso.", true, "VIP_REFUND_FAILED");
    }
  }

  const reservations = await reservationsForOrder(orderId);
  await firestorePos.runTransaction(async (tx) => {
    const latestOrderDoc = await tx.get(orderRef);
    if (!latestOrderDoc.exists) return;
    const latestOrder = latestOrderDoc.data() as VipOrder;
    const confirmed: Array<{
      reservation: FirebaseFirestore.DocumentSnapshot;
      stock: FirebaseFirestore.DocumentSnapshot | null;
      restoreStock: boolean;
    }> = [];
    const inventoryHeaders = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    const confirmedReservations: FirebaseFirestore.DocumentSnapshot[] = [];
    for (const reservationDoc of reservations.docs) {
      const reservation = await tx.get(reservationDoc.ref);
      if (reservation.data()?.status !== VipReservationStatus.CONFIRMED) continue;
      confirmedReservations.push(reservation);
    }
    for (const reservation of confirmedReservations) {
      const inventoryId = String(reservation.data()?.inventoryId || "");
      if (!inventoryId || inventoryHeaders.has(inventoryId)) continue;
      inventoryHeaders.set(inventoryId, await tx.get(col(COLLECTIONS.INVENTARIOS).doc(inventoryId)));
    }
    for (const reservation of confirmedReservations) {
      const data = reservation.data() || {};
      const inventoryId = String(data.inventoryId || "");
      const restoreStock = isOpenInventoryHeader(inventoryHeaders.get(inventoryId)?.data());
      const stock = restoreStock
        ? await tx.get(
          col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
            .collection(SUBCOLLECTIONS.PRODUCTOS).doc(String(data.productId)),
        )
        : null;
      confirmed.push({ reservation, stock, restoreStock });
    }
    const serviceRef = orderServiceRef(latestOrder);
    const serviceDoc = latestOrder.capacityReleased ? null : await tx.get(serviceRef);
    for (const pair of confirmed) {
      const data = pair.reservation.data() || {};
      const quantity = Number(data.quantity || 0);
      if (pair.restoreStock && pair.stock) {
        const current = Number(pair.stock.data()?.cantidad_final ?? pair.stock.data()?.cantidad_inicial ?? 0);
        const restored = releaseVipStock(current, quantity);
        tx.update(pair.stock.ref, { cantidad_final: restored, updatedAt: FieldValue.serverTimestamp() });
        tx.create(
          col(COLLECTIONS.INVENTARIOS).doc(String(data.inventoryId))
            .collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(),
          {
            tipo: "REINTEGRO_VIP",
            producto_id: data.productId,
            cantidad: quantity,
            cantidad_anterior: current,
            cantidad_nueva: restored,
            sucursal_id: data.sucursalId,
            vipOrderId: orderId,
            motivo: `Reembolso Stripe ${refund.id}`,
            createdAt: FieldValue.serverTimestamp(),
          },
        );
      }
      tx.update(pair.reservation.ref, {
        status: VipReservationStatus.RESTORED,
        restoredToInventory: pair.restoreStock,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    if (!latestOrder.capacityReleased && serviceDoc?.exists) {
      tx.update(serviceRef, {
        activeOrderCount: Math.max(0, activeOrderCount(serviceDoc.data() || {}) - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    for (const fulfillment of latestOrder.fulfillments) {
      tx.set(col(COLLECTIONS.COMPROBANTES_VENTA).doc(vipSaleDocId(orderId, fulfillment, latestOrder.fulfillments)), {
        status: "REFUNDED",
        refundId: refund.id,
        refundedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    tx.update(orderRef, {
      status: VipOrderStatus.REFUNDED,
      "payment.status": VipPaymentStatus.REFUNDED,
      "payment.refundId": refund.id,
      capacityReleased: true,
      "timestamps.cancelledAt": FieldValue.serverTimestamp(),
      "timestamps.refundedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(operationRef, {
      status: "COMPLETED",
      refundId: refund.id,
      amountMinor: refund.amount,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.create(orderEventRef(orderId), eventPayload("ORDER_CANCELLED", latestOrder.status, VipOrderStatus.CANCELLED, actor, { reason }));
    tx.create(orderEventRef(orderId), eventPayload("REFUND_CREATED", VipOrderStatus.CANCELLED, VipOrderStatus.REFUNDED, actor, { refundId: refund.id }));
  });
  order = await loadOrder(orderId);
  console.info("vip_refund_processed", {
    orderId,
    orderNumber: order.orderNumber,
    paymentIntentId: order.payment.paymentIntentId,
    action: "refund",
    status: order.payment.status,
  });
  return order;
}

async function reconcileStripeRefund(
  orderId: string,
  refundId: string,
  amountMinor: number,
  actor: Actor,
) {
  const order = await loadOrder(orderId);
  if (order.payment.status === VipPaymentStatus.REFUNDED) return order;
  if (amountMinor < order.totalMinor) {
    const orderRef = orderCol().doc(orderId);
    await firestorePos.runTransaction(async (tx) => {
      const latest = await tx.get(orderRef);
      if (!latest.exists || latest.data()?.payment?.status === VipPaymentStatus.REFUNDED) return;
      tx.update(orderRef, {
        "payment.status": VipPaymentStatus.PARTIALLY_REFUNDED,
        "payment.refundId": refundId,
        "payment.refundedAmountMinor": amountMinor,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(orderEventRef(orderId), eventPayload(
        "REFUND_CREATED",
        order.status,
        order.status,
        actor,
        { refundId, amountMinor, partial: true },
      ));
    });
    return loadOrder(orderId);
  }
  return performRefund(
    orderId,
    "Reembolso confirmado por webhook Stripe",
    actor,
    { id: refundId, amount: amountMinor },
  );
}

export const cancelOrder = async (orderId: string, reason: string, actor: Actor) => {
  const order = await loadOrder(orderId);
  if ([
    VipPaymentStatus.PAID,
    VipPaymentStatus.REFUND_PENDING,
    VipPaymentStatus.PARTIALLY_REFUNDED,
  ].includes(order.payment.status)) {
    return performRefund(orderId, reason, actor);
  }
  if (isVipTerminalStatus(order.status)) {
    throw new ApiError(409, "La orden ya está cerrada.", true, "VIP_INVALID_STATE_TRANSITION");
  }
  await releaseReservations(orderId, VipOrderStatus.CANCELLED, VipPaymentStatus.FAILED, reason, actor);
  const cancelled = await loadOrder(orderId);
  console.info("vip_order_cancelled", {
    orderId,
    orderNumber: cancelled.orderNumber,
    action: "cancel",
    status: cancelled.status,
    actorId: actor.actorId,
  });
  return cancelled;
};

export const refundOrder = performRefund;

export const getPrintData = async (orderId: string, actor: Actor) => {
  const order = await loadOrder(orderId);
  await orderEventRef(orderId).set(eventPayload("PRINT_REQUESTED", order.status, order.status, actor));
  return {
    preparationTickets: order.fulfillments.map((fulfillment) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      concession: { id: fulfillment.concessionId, name: fulfillment.concessionName },
      items: order.items.filter((item) => fulfillment.itemIds.includes(item.id)).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        options: item.selectedOptions,
        extras: item.extras,
        notes: item.notes,
      })),
      timestamp: order.createdAt,
    })),
    deliveryTicket: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customer: order.customer,
      delivery: order.delivery,
      itemsCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      total: order.total,
      currency: order.currency,
      runner: order.runner,
      trackingIdentifier: createHash("sha256").update(order.id).digest("hex").slice(0, 16),
      trackingToken: buildTrackingToken(order.id),
    },
  };
};

export const expireReservations = async (limit = 100) => {
  const expiredSnap = await col(COLLECTIONS.VIP_RESERVATIONS)
    .where("status", "==", VipReservationStatus.ACTIVE)
    .where("expiresAt", "<=", Timestamp.now())
    .limit(limit)
    .get();
  const activeSnap = await col(COLLECTIONS.VIP_RESERVATIONS)
    .where("status", "==", VipReservationStatus.ACTIVE)
    .limit(limit)
    .get();
  const orderIds = new Set(expiredSnap.docs.map((doc) => String(doc.data().orderId)));
  const inventoryIds = [...new Set(
    activeSnap.docs.map((doc) => String(doc.data().inventoryId || "")).filter(Boolean),
  )];
  const closedInventories = new Set<string>();
  for (const inventoryId of inventoryIds) {
    const header = await col(COLLECTIONS.INVENTARIOS).doc(inventoryId).get();
    if (!header.exists || !isOpenInventoryHeader(header.data())) {
      closedInventories.add(inventoryId);
    }
  }
  for (const doc of activeSnap.docs) {
    if (closedInventories.has(String(doc.data().inventoryId || ""))) {
      orderIds.add(String(doc.data().orderId));
    }
  }
  for (const orderId of orderIds) {
    const order = await loadOrder(orderId);
    if (order.payment.status !== VipPaymentStatus.PAID) {
      await releaseReservations(orderId, VipOrderStatus.PAYMENT_FAILED, VipPaymentStatus.FAILED, "Reserva VIP expirada");
    }
  }
  return { expiredOrders: orderIds.size, reservations: expiredSnap.size };
};
