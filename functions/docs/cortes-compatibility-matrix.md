# Cortes compatibility matrix

This matrix records only shapes evidenced by validators, models, and write paths in this repository. It is not an inventory of production data. New fields are optional and must not replace or change the type of legacy fields.

## Persisted contracts

| Collection / path | Current field and type | Current use | Future optional complement | Historical default |
|---|---|---|---|---|
| `comprobantes_venta` | `ventaId`, `concesionId`, `sucursalId`, `inventarioId`: string | Sale identity/scope | `sesionCajaId`, `businessDate`: string | Derive scope only when evidence exists; otherwise `null` |
| `comprobantes_venta` | `jornadaId`, `cajaId`, `cajaNombre`, `idUser`, `cajeroNombre`: string or null | Operational attribution | none; preserve names/types | `null` |
| `comprobantes_venta` | `total`: number; `metodoPago`: string | Charged value/payment fallback | `calculationVersion`: string | `legacy-v1` |
| `comprobantes_venta` | `montoEfectivo`, `montoTarjeta`, `montoPuntos`, `puntosUsados`: number or null | Explicit payment split | `estado`, refund references/splits | Missing state means legacy valid sale |
| `comprobantes_venta` | `lineasVenta`: array; `abonado`: object or null | Original sale lines/benefit snapshot | explicit courtesy/promotion classification | Zero-price line uses legacy courtesy fallback |
| `comprobantes_venta/{id}/detalle` | `producto`: string; `cantidad`, `precio_actual`, `subtotal`: number | Expanded product lines | reference price/classification fields | Existing values unchanged |
| `cortes` | `fecha`, `estatus`: string; `totalReal`, `totalCaja`: number | Legacy close summary | `calculationVersion`, `businessDate`, `sesionCajaId` | `legacy-v1`; derived session ID only in adapter |
| `cortes` | payment/points/count/difference fields: number or null | Additive close breakdown | versioned snapshot objects | Read legacy scalar fields when snapshots are absent |
| `cortes` | `productos`: array or null; `promociones2x1`, `combos`: object or null | Partial historical snapshot | immutable finance/payment/product/inventory/commission snapshots | Empty only when the source field is absent |
| `inventarios` | `jornada_fecha`: string; `jornada_numero`: number; `concesion_id`: string; `sucursal_id`: string or null | Jornada inventory scope | `businessDate`, reconciliation metadata | Existing jornada fields remain authoritative |
| `inventarios/{id}/productos` | `producto_id`: string; quantities/prices: number | Initial/current stock | physical count and reconciliation snapshot | Missing values remain “not recorded”, not invented |
| `inventarios/{id}/movimientos` | `tipo`: `CARGA_INICIAL \| AJUSTE \| VENTA`; quantities: number | Stock mutation ledger | additive transfer/courtesy/waste/refund types | Preserve current enum values |
| `asignaciones_cajas_jornada` | jornada/concession/branch/caja/vendor IDs: string; `activo`: boolean | Caja-to-seller assignment | session reference | No session implied |
| `sucursales/{id}/cajas` | `nombre`: string; `activo`: boolean; `orden`: number | Caja catalog | session policy fields | Existing values unchanged |
| `concesiones` | `porcentajeComision`: number or null | Live commission rule | versioned commission configuration | `0` only for calculation when absent |
| POS `users` / external `usuariosApp` | role/scope IDs: string or null | Server-side authorization scope | explicit corte permissions | Continue role mapping until permissions exist |

## Collections not currently evidenced

No POS collection or persisted contract currently exists for `sesiones_caja`, cash movements, corte adjustments, corte audit, or `mermas`. Introduce them additively; do not reinterpret inventory `AJUSTE` as waste or a sale receipt as a cash movement.

## Adapter rules in this slice

- `normalizarComprobanteLegacy` creates a new normalized object and never mutates the Firestore-shaped input.
- Missing `calculationVersion` resolves to `legacy-v1`; missing sale state resolves to `VALIDA` for legacy compatibility.
- A positive explicit payment split wins; zero-only split fields retain the `metodoPago` and `total` legacy fallback.
- An incomplete partial-refund split is reversed in full and emits the blocking `PARTIAL_REFUND_SPLIT_REQUIRED` incident.
- Missing line prices are not zero: resolved `detalle` prices take precedence when `lineasVenta` lacks them. A true zero-price line is a courtesy only when explicitly marked, or when processed as `legacy-v1`.
