/**
 * Detecta ventas de palcos (sistema VIP Stripe) por convención de datos.
 * Case-insensitive:
 * - cajaNombre === "VIP", o
 * - cajeroNombre contiene "VIP Stripe", o
 * - ventaId empieza con "vip_"
 */
export const isVentaPalcos = (
  venta: Record<string, unknown> | null | undefined,
): boolean => {
  if (!venta) return false;

  const cajaNombre = String(venta.cajaNombre ?? "")
    .trim()
    .toLowerCase();
  if (cajaNombre === "vip") return true;

  const cajeroNombre = String(venta.cajeroNombre ?? "")
    .trim()
    .toLowerCase();
  if (cajeroNombre.includes("vip stripe")) return true;

  const ventaId = String(venta.ventaId ?? "")
    .trim()
    .toLowerCase();
  if (ventaId.startsWith("vip_")) return true;

  return false;
};
