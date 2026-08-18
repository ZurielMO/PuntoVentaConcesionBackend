import { Router } from "express";
import * as q from "../controllers/inventarios/inventarios.query.controller";
import * as c from "../controllers/inventarios/inventarios.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware } from "../utils/middlewares";
import {
  requireAuthenticated,
  requireInventarioReadAccess,
  requireInventarioWriteAccess,
} from "../utils/roles.middlewares";
import {
  ajustarInventarioProductoSchema,
  upsertInventarioProductoSchema,
} from "../middleware/validators/inventario.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getInventarios); // filtrado por concesión en el service

router.post(
  "/jornada-activa",
  requireInventarioWriteAccess,
  c.openInventarioJornadaActiva,
);

router.get(
  "/jornada-activa",
  requireAuthenticated,
  q.getInventarioJornadaActiva,
);

router.post(
  "/jornadas/:jornadaNumero/fechas/:fechaJornada/sucursales/:sucursalId",
  requireInventarioWriteAccess,
  c.createInventario,
);

router.get("/:id", requireInventarioReadAccess, q.getInventarioById);
router.delete("/:id", requireInventarioWriteAccess, c.deleteInventario);

router.get("/:id/movimientos", requireInventarioReadAccess, q.getInventarioMovimientos);

router.get("/:id/productos", requireInventarioReadAccess, q.getInventarioProductos);
router.get("/:id/productos/:productoId", requireInventarioReadAccess, q.getInventarioProducto);
router.put(
  "/:id/productos/:productoId",
  requireInventarioWriteAccess,
  validateBody(upsertInventarioProductoSchema),
  c.upsertInventarioProducto,
);
router.post(
  "/:id/productos/:productoId/ajustes",
  requireInventarioWriteAccess,
  validateBody(ajustarInventarioProductoSchema),
  c.ajustarInventarioProducto,
);
router.delete(
  "/:id/productos/:productoId",
  requireInventarioWriteAccess,
  c.deleteInventarioProducto,
);

export default router;