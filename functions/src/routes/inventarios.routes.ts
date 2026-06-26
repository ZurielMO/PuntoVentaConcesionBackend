import { Router } from "express";
import * as q from "../controllers/inventarios/inventarios.query.controller";
import * as c from "../controllers/inventarios/inventarios.command.controller";
import { validateBody } from "../middleware/validation.middleware";
import { authMiddleware, requireAdmin } from "../utils/middlewares";
import { upsertInventarioProductoSchema } from "../middleware/validators/inventario.validator";

const router = Router();

router.use(authMiddleware);

router.get("/", q.getInventarios);

router.post(
  "/jornadas/:jornadaNumero/fechas/:fechaJornada/sucursales/:sucursalId",
  requireAdmin,
  c.createInventario,
);

router.get("/:id", q.getInventarioById);
router.delete("/:id", requireAdmin, c.deleteInventario);

router.get("/:id/productos", q.getInventarioProductos);
router.get("/:id/productos/:productoId", q.getInventarioProducto);
router.put(
  "/:id/productos/:productoId",
  requireAdmin,
  validateBody(upsertInventarioProductoSchema),
  c.upsertInventarioProducto,
);
router.delete(
  "/:id/productos/:productoId",
  requireAdmin,
  c.deleteInventarioProducto,
);

export default router;
