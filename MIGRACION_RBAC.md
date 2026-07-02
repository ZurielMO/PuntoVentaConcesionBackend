# Migración RBAC — datos legacy

Si ya existían documentos en Firestore antes de esta reestructuración, revisa:

## Usuarios (`users`)

- Normalizar `idConcesion` → `concesionId` e `idSucursal` → `sucursalId`.
- Vendedores deben tener `sucursalId` apuntando a una sucursal de su `concesionId`.
- Solo usuarios con `rol: SUPERADMIN` pueden omitir `concesionId`.

## Tickets (`tickets`) y cortes (`cortes`)

- Backfill de `concesionId` desde el perfil del `idUser` o desde la venta asociada.
- Opcional: `sucursalId` desde el perfil del vendedor.

## Inventarios / ventas

- Los comprobantes en `comprobantes_venta` ya incluyen `concesionId`, `sucursalId`, `inventarioId`.
- Verificar que inventarios tengan `concesion_id` desnormalizado.

### IDs de inventario (migración julio 2026)

Los inventarios **nuevos** usan el formato:

```text
{fecha}__J{numero}__{concesionId}
```

Ejemplo: `2026-07-17__J1__abcConcesionId`

Los registros **legacy** terminaban en `sucursalId` (ej. `2026-07-17__J1__ihtls10eLXXD5I2htMF1`). Quedan obsoletos: el stock compartido por concesión no los usa. Si tenían productos cargados, recrea el inventario con `POST /inventarios/jornada-activa` y vuelve a cargar cantidades iniciales.

Subcolección nueva `movimientos` en cada inventario: registra `CARGA_INICIAL`, `AJUSTE` y `VENTA` (con `sucursal_id` del vendedor en ventas).

## Script manual (ejemplo en consola Firebase)

```javascript
// Pseudocódigo: migrar idConcesion legacy
const snap = await db.collection('users').get();
for (const doc of snap.docs) {
  const d = doc.data();
  if (d.idConcesion && !d.concesionId) {
    await doc.ref.update({ concesionId: d.idConcesion });
  }
}
```
