export const CINEPOLIS_CASHIER_EMAIL = "cinepoliscl@clubleon.mx";

export const isCinepolisCashierEmail = (
  email?: string | null,
): boolean => (email ?? "").trim().toLowerCase() === CINEPOLIS_CASHIER_EMAIL;
