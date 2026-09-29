import { Timestamp } from "firebase-admin/firestore";
import { firestorePos } from "../../config/firebase";
import { COLLECTIONS, SUBCOLLECTIONS } from "../../config/firestore.constants";
import { getVipBusinessDate } from "../../config/vip.config";
import {
  isVipPreorder,
  VipOrder,
  VipOrderStatus,
  VipPaymentStatus,
  VipReservationStatus,
} from "../../models/vip.model";
import { buildJornadaId } from "../asignacion-caja.service";
import {
  applyDeferredVipStock,
  shouldSettleDeferredPreorder,
} from "./vip-inventory.service";

type DocData = FirebaseFirestore.DocumentData;

const col = (name: string) => firestorePos.collection(name);
const orderCol = () => col(COLLECTIONS.VIP_ORDERS);

export const vipSaleDocId = (
  orderId: string,
  fulfillment: VipOrder["fulfillments"][number],
  siblings: VipOrder["fulfillments"],
): string => {
  const sameConcession = siblings.filter((row) => row.concessionId === fulfillment.concessionId);
  return sameConcession.length > 1
    ? `vip_${orderId}_${fulfillment.concessionId}_${fulfillment.sucursalId}`
    : `vip_${orderId}_${fulfillment.concessionId}`;
};

const reservationStockTaken = (data: DocData | undefined): boolean => {
  if (!data) return false;
  if (data.inventoryDeferred === true) return data.inventoryApplied === true;
  return data.inventoryApplied !== false;
};

/** Un movimiento por reserva. Reintentar la misma orden no abre otro documento. */
export const preorderMovementId = (reservationId: string): string => `preorder_${reservationId}`;

type SettleOptions = {
  /** En preparación, la línea del producto basta: aunque la carga inicial siga en cero. */
  whenProductLineExists?: boolean;
  /** Ids de inventario guardados en la reserva que deben aplicarse sobre el inventario destino. */
  sourceInventoryIds?: string[];
};

export const reservationAwaitingInventory = (data: DocData | undefined): boolean =>
  data?.inventoryDeferred === true && data?.inventoryApplied !== true &&
  data?.status === VipReservationStatus.CONFIRMED;

const logSettleFailure = (inventarioId: string, error: unknown) => {
  console.error("vip_deferred_inventory_settle_failed", {
    inventarioId,
    message: error instanceof Error ? error.message : "unknown",
  });
};

const writeFulfillmentSale = (
  tx: FirebaseFirestore.Transaction,
  order: VipOrder,
  fulfillment: VipOrder["fulfillments"][number],
  now: FirebaseFirestore.Timestamp,
) => {
  const preorder = isVipPreorder(order) ? order.preorder : null;
  const saleId = vipSaleDocId(order.id, fulfillment, order.fulfillments);
  const saleRef = col(COLLECTIONS.COMPROBANTES_VENTA).doc(saleId);
  const jornadaId = preorder
    ? buildJornadaId(preorder.matchDate, preorder.jornadaNumero, "varonil")
    : order.jornadaId;
  tx.set(saleRef, {
    ventaId: saleId,
    vipOrderId: order.id,
    vipOrderNumber: order.orderNumber,
    vipOrderType: preorder ? "PREORDER" : "IMMEDIATE",
    ...(preorder ? { vipMatchId: preorder.matchId, vipScheduledFor: preorder.windowStartAt } : {}),
    concesionId: fulfillment.concessionId,
    sucursalId: fulfillment.sucursalId,
    inventarioId: fulfillment.inventoryId,
    jornadaId,
    metodoPago: "tarjeta",
    source: "VIP",
    channel: "VIP_DELIVERY",
    total: fulfillment.subtotal,
    montoTarjeta: fulfillment.subtotal,
    vipOrderTotal: order.total,
    paymentIntentId: order.payment.paymentIntentId,
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
};

const inventoryMatchesMatchDate = (id: string, data: DocData, matchDate: string): boolean => {
  if (!matchDate) return false;
  if (id.startsWith(`${matchDate}__`)) return true;
  const fecha = data.jornada_fecha;
  return typeof fecha === "string" && fecha.slice(0, 10) === matchDate;
};

const openProductLineExists = async (inventoryId: string, productId: string): Promise<boolean> => {
  const header = await col(COLLECTIONS.INVENTARIOS).doc(inventoryId).get();
  if (!header.exists || header.data()?.activo !== true) return false;
  const line = await header.ref.collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId).get();
  return line.exists;
};

/**
 * Inventario donde debe caer la preventa al mandarla a preparación.
 * Usa el id de la reserva si esa línea ya existe. Si no, el único inventario
 * abierto de la concesión para la fecha del partido.
 */
const resolvePreparationInventory = async (data: DocData): Promise<string> => {
  const reservedId = String(data.inventoryId || "");
  const productId = String(data.productId || "");
  if (reservedId && productId && await openProductLineExists(reservedId, productId)) return reservedId;

  const concessionId = String(data.concessionId || "");
  const matchDate = String(data.matchDate || data.jornadaFecha || "");
  const sucursalId = String(data.sucursalId || "");
  if (!concessionId || !productId || !matchDate) return reservedId;

  const snap = await col(COLLECTIONS.INVENTARIOS).where("concesion_id", "==", concessionId).limit(40).get();
  const matches: Array<{ id: string; sucursalId: string }> = [];
  for (const doc of snap.docs) {
    if (doc.data()?.activo !== true) continue;
    if (!inventoryMatchesMatchDate(doc.id, doc.data() || {}, matchDate)) continue;
    const line = await doc.ref.collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId).get();
    if (!line.exists) continue;
    matches.push({ id: doc.id, sucursalId: String(doc.data()?.sucursal_id || "") });
  }
  const sameBranch = sucursalId ? matches.filter((row) => row.sucursalId === sucursalId) : matches;
  if (sameBranch.length === 1) return sameBranch[0].id;
  if (sameBranch.length === 0 && matches.length === 1) return matches[0].id;
  return reservedId;
};

/**
 * Applies paid, not-yet-posted preorders onto one inventory header.
 * Writes the sale receipt only after every draw of that fulfillment is in stock.
 */
export const applyDeferredVipInventory = async (inventoryId: string): Promise<number> => {
  const trimmed = inventoryId.trim();
  if (!trimmed) return 0;
  const snap = await col(COLLECTIONS.VIP_RESERVATIONS).where("inventoryId", "==", trimmed).get();
  const orderIds = [...new Set(
    snap.docs
      .filter((doc) => reservationAwaitingInventory(doc.data()))
      .map((doc) => String(doc.data()?.orderId || ""))
      .filter(Boolean),
  )];
  let applied = 0;
  for (const orderId of orderIds) {
    applied += await settleOrderOnInventory(orderId, trimmed);
  }
  return applied;
};

/** Registra stock y comprobante de una preventa al pasarla a preparación. Si no hay línea, no bloquea. */
export const postPreorderInventoryForPreparation = async (orderId: string): Promise<void> => {
  const snap = await col(COLLECTIONS.VIP_RESERVATIONS).where("orderId", "==", orderId).get();
  const groups = new Map<string, Set<string>>();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (!reservationAwaitingInventory(data)) continue;
    const reservedId = String(data.inventoryId || "");
    const target = await resolvePreparationInventory(data);
    const inventoryId = target || reservedId;
    if (!inventoryId) continue;
    const sources = groups.get(inventoryId) ?? new Set<string>();
    if (reservedId) sources.add(reservedId);
    sources.add(inventoryId);
    groups.set(inventoryId, sources);
  }
  for (const [inventoryId, sources] of groups) {
    await settleOrderOnInventory(orderId, inventoryId, {
      whenProductLineExists: true,
      sourceInventoryIds: [...sources],
    });
  }
};

const settleOrderOnInventory = async (
  orderId: string,
  inventoryId: string,
  options: SettleOptions = {},
): Promise<number> => {
  const businessDate = getVipBusinessDate();
  return firestorePos.runTransaction(async (tx) => {
    const orderRef = orderCol().doc(orderId);
    const orderDoc = await tx.get(orderRef);
    if (!orderDoc.exists) return 0;
    const order = orderDoc.data() as VipOrder;
    if (order.payment.status !== VipPaymentStatus.PAID &&
        order.payment.status !== VipPaymentStatus.PARTIALLY_REFUNDED) {
      return 0;
    }
    if (order.status === VipOrderStatus.REFUNDED || order.status === VipOrderStatus.CANCELLED) return 0;

    const reservationSnap = await tx.get(
      col(COLLECTIONS.VIP_RESERVATIONS).where("orderId", "==", orderId),
    );
    const reservations = reservationSnap.docs.map((doc) => ({
      ref: doc.ref,
      data: doc.data() || {},
    }));
    const sourceIds = new Set(
      options.sourceInventoryIds?.length ? options.sourceInventoryIds : [inventoryId],
    );
    const pending = reservations.filter((row) =>
      sourceIds.has(String(row.data.inventoryId || "")) && reservationAwaitingInventory(row.data),
    );
    if (!pending.length) return 0;

    const header = await tx.get(col(COLLECTIONS.INVENTARIOS).doc(inventoryId));
    const headerOpen = Boolean(header.exists && header.data()?.activo === true);
    const stockDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    if (headerOpen) {
      for (const row of pending) {
        const productId = String(row.data.productId || "");
        if (!productId || stockDocs.has(productId)) continue;
        stockDocs.set(
          productId,
          await tx.get(
            col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
              .collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId),
          ),
        );
      }
    }

    const applicable = headerOpen
      ? pending.filter((row) => {
        const productId = String(row.data.productId || "");
        const stock = stockDocs.get(productId);
        const inicial = stock?.exists ? Number(stock.data()?.cantidad_inicial ?? 0) : 0;
        const matchDate = String(row.data.matchDate || row.data.jornadaFecha || "");
        if (!stock?.exists) return shouldSettleDeferredPreorder(0, matchDate, businessDate) && businessDate >= matchDate;
        if (options.whenProductLineExists) return true;
        return shouldSettleDeferredPreorder(inicial, matchDate, businessDate);
      })
      : [];

    const saleRefs = order.fulfillments.map((fulfillment) => ({
      fulfillment,
      ref: col(COLLECTIONS.COMPROBANTES_VENTA).doc(vipSaleDocId(order.id, fulfillment, order.fulfillments)),
    }));
    const saleDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const sale of saleRefs) {
      saleDocs.set(sale.ref.path, await tx.get(sale.ref));
    }

    if (!applicable.length) return 0;

    const movementDocs = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const row of applicable) {
      const movementRef = col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
        .collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(preorderMovementId(row.ref.id));
      movementDocs.set(row.ref.path, await tx.get(movementRef));
    }

    const now = Timestamp.now();
    const appliedPaths = new Set<string>();
    const running = new Map<string, number>();
    let applied = 0;
    let relinkFulfillment = false;
    for (const row of applicable) {
      const productId = String(row.data.productId || "");
      const quantity = Number(row.data.quantity || 0);
      if (!productId || !Number.isInteger(quantity) || quantity <= 0) continue;
      if (String(row.data.inventoryId || "") !== inventoryId) relinkFulfillment = true;
      const existingMovement = movementDocs.get(row.ref.path);
      if (existingMovement?.exists) {
        tx.update(row.ref, {
          inventoryApplied: true,
          inventoryId,
          updatedAt: now,
        });
        appliedPaths.add(row.ref.path);
        applied += 1;
        continue;
      }
      const stock = stockDocs.get(productId);
      const stockRef = col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
        .collection(SUBCOLLECTIONS.PRODUCTOS).doc(productId);
      let current = 0;
      if (running.has(productId)) {
        current = Number(running.get(productId));
      } else if (stock?.exists) {
        current = Number(stock.data()?.cantidad_final ?? stock.data()?.cantidad_inicial ?? 0);
      }
      const next = applyDeferredVipStock(current, quantity);
      running.set(productId, next);
      if (!stock?.exists) {
        tx.set(stockRef, {
          producto_id: productId,
          cantidad_inicial: 0,
          cantidad_final: next,
          updatedAt: now,
        });
      } else {
        tx.update(stockRef, { cantidad_final: next, updatedAt: now });
      }
      tx.create(
        col(COLLECTIONS.INVENTARIOS).doc(inventoryId)
          .collection(SUBCOLLECTIONS.MOVIMIENTOS).doc(preorderMovementId(row.ref.id)),
        {
          tipo: "VENTA",
          producto_id: productId,
          cantidad: -quantity,
          cantidad_anterior: current,
          cantidad_nueva: next,
          sucursal_id: row.data.sucursalId ?? null,
          ventaId: order.id,
          vipOrderId: order.id,
          reservaId: row.ref.id,
          motivo: "Preventa VIP aplicada al inventario del partido",
          createdAt: now,
        },
      );
      tx.update(row.ref, {
        inventoryApplied: true,
        inventoryId,
        updatedAt: now,
      });
      appliedPaths.add(row.ref.path);
      applied += 1;
    }

    const isApplied = (row: { ref: FirebaseFirestore.DocumentReference; data: DocData }) =>
      appliedPaths.has(row.ref.path) || row.data.inventoryApplied === true || row.data.inventoryDeferred !== true;

    const fulfillments = relinkFulfillment
      ? order.fulfillments.map((row) =>
        sourceIds.has(row.inventoryId) && row.inventoryId !== inventoryId
          ? { ...row, inventoryId }
          : row,
      )
      : order.fulfillments;
    const recordedSales = relinkFulfillment
      ? fulfillments.map((fulfillment) => ({
        fulfillment,
        ref: col(COLLECTIONS.COMPROBANTES_VENTA).doc(vipSaleDocId(order.id, fulfillment, fulfillments)),
      }))
      : saleRefs;

    let allRecorded = true;
    for (const sale of recordedSales) {
      const draws = reservations.filter((row) => {
        const reservationInventoryId = appliedPaths.has(row.ref.path)
          ? inventoryId
          : String(row.data.inventoryId || "");
        const fulfillmentInventoryId = sale.fulfillment.inventoryId;
        const sameInventory = reservationInventoryId === fulfillmentInventoryId ||
          (sourceIds.has(reservationInventoryId) && sourceIds.has(fulfillmentInventoryId));
        return sameInventory &&
          String(row.data.concessionId || "") === sale.fulfillment.concessionId &&
          row.data.status !== VipReservationStatus.RELEASED &&
          row.data.status !== VipReservationStatus.RESTORED;
      });
      const ready = draws.length > 0 && draws.every(isApplied);
      if (!ready) {
        allRecorded = false;
        continue;
      }
      const existing = saleDocs.get(sale.ref.path);
      if (existing?.exists && existing.data()?.vipOrderId) continue;
      writeFulfillmentSale(tx, order, sale.fulfillment, now);
    }
    if (allRecorded && (relinkFulfillment || order.salesRecorded !== true)) {
      tx.update(orderRef, {
        ...(relinkFulfillment ? { fulfillments } : {}),
        salesRecorded: true,
        inventoryConfirmed: true,
        updatedAt: now,
      });
    }
    return applied;
  });
};

export const settleDeferredVipSalesForCorte = async (
  filters: { inventarioId?: string; sucursalId?: string },
): Promise<void> => {
  const ids = new Set<string>();
  if (filters.inventarioId) ids.add(filters.inventarioId);
  if (filters.sucursalId) {
    const snap = await col(COLLECTIONS.INVENTARIOS)
      .where("sucursal_id", "==", filters.sucursalId)
      .limit(20)
      .get();
    for (const doc of snap.docs) {
      if (doc.data()?.activo === true) ids.add(doc.id);
    }
  }
  for (const id of ids) {
    try {
      await applyDeferredVipInventory(id);
    } catch (error) {
      logSettleFailure(id, error);
    }
  }
};

export const settleInventoryQuietly = async (inventarioId: string | null | undefined): Promise<void> => {
  if (!inventarioId) return;
  try {
    await applyDeferredVipInventory(inventarioId);
    await postAwaitingPreordersOntoInventory(inventarioId);
  } catch (error) {
    logSettleFailure(inventarioId, error);
  }
};

/**
 * Al guardar el inventario del partido, aplica preventas que seguían pendientes
 * aunque la orden ya esté en preparación o el id del documento no sea el de la reserva.
 */
const postAwaitingPreordersOntoInventory = async (inventarioId: string): Promise<void> => {
  const header = await col(COLLECTIONS.INVENTARIOS).doc(inventarioId).get();
  const data = header.data() || {};
  if (!header.exists || data.activo !== true) return;
  const concessionId = String(data.concesion_id || "");
  const matchDate = typeof data.jornada_fecha === "string" ? data.jornada_fecha.slice(0, 10) : "";
  if (!concessionId || !matchDate) return;
  const snap = await col(COLLECTIONS.VIP_RESERVATIONS)
    .where("concessionId", "==", concessionId)
    .limit(200)
    .get();
  const orderIds = [...new Set(
    snap.docs
      .filter((doc) => {
        const row = doc.data() || {};
        const date = String(row.matchDate || row.jornadaFecha || "").slice(0, 10);
        return reservationAwaitingInventory(row) && date === matchDate;
      })
      .map((doc) => String(doc.data()?.orderId || ""))
      .filter(Boolean),
  )];
  for (const orderId of orderIds) {
    await postPreorderInventoryForPreparation(orderId);
  }
};

/** Legacy immediate reservations already decremented stock. Deferred ones only after apply. */
export const vipReservationDecrementedStock = reservationStockTaken;

export const preorderLinePrice = (
  inventoryPrice: unknown,
  catalogPrice: unknown,
): number => {
  const fromInventory = Number(inventoryPrice);
  if (inventoryPrice !== undefined && inventoryPrice !== null && Number.isFinite(fromInventory) && fromInventory >= 0) {
    return fromInventory;
  }
  return Number(catalogPrice);
};
