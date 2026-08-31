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
