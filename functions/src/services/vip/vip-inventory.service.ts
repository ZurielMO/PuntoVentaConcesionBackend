import { ApiError } from "../../utils/api-error";

/** Pure stock arithmetic shared by transaction code and deterministic tests. */
export const reserveVipStock = (available: number, requested: number): number => {
  if (!Number.isFinite(available) || available < 0 || !Number.isInteger(requested) || requested <= 0) {
    throw new ApiError(409, "Inventario VIP inválido.", true, "VIP_OUT_OF_STOCK");
  }
  if (available < requested) {
    throw new ApiError(409, "Uno o más productos ya no tienen stock suficiente.", true, "VIP_OUT_OF_STOCK");
  }
  return available - requested;
};

export const releaseVipStock = (availableAfterReservation: number, reserved: number): number => {
  if (!Number.isFinite(availableAfterReservation) || availableAfterReservation < 0 ||
      !Number.isInteger(reserved) || reserved <= 0) {
    throw new ApiError(500, "Reserva VIP inválida.", false, "VIP_INVALID_CONFIG");
  }
  return availableAfterReservation + reserved;
};

/** Confirmation consumes the already-decremented reservation exactly once. */
export const confirmVipStock = (availableAfterReservation: number): number => availableAfterReservation;

/**
 * Applies a paid preorder onto inventory that may still be short.
 * The result can be negative: those units stay inside the same stock line.
 */
export const applyDeferredVipStock = (available: number, requested: number): number => {
  if (!Number.isFinite(available) || !Number.isInteger(requested) || requested <= 0) {
    throw new ApiError(409, "Inventario VIP inválido.", true, "VIP_OUT_OF_STOCK");
  }
  return available - requested;
};

/** Puts units back even if the line is already negative after a deferred preorder. */
export const restoreAppliedVipStock = (current: number, reserved: number): number => {
  if (!Number.isFinite(current) || !Number.isInteger(reserved) || reserved <= 0) {
    throw new ApiError(500, "Reserva VIP inválida.", false, "VIP_INVALID_CONFIG");
  }
  return current + reserved;
};

/** Stock was loaded, or the business date has reached the match. */
export const shouldSettleDeferredPreorder = (
  cantidadInicial: number,
  matchDate: string,
  businessDate: string,
): boolean => {
  if (Number.isFinite(cantidadInicial) && cantidadInicial > 0) return true;
  return Boolean(matchDate) && businessDate >= matchDate;
};
