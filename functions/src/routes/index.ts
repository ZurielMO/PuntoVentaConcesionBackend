/**
 * RUTAS PRINCIPALES DEL API (POS Concesiones Estadio)
 * ---------------------------------------------------------------------
 * Hub central de rutas. En Cloud Functions el prefijo `/api` lo aporta el
 * nombre de la function; en local `app.ts` reescribe `/api/*` -> `/*`.
 */

import { Router, Request, Response } from "express";
import authRoutes from "./auth.routes";
import concessionsRoutes from "./concessions.routes";
import productsRoutes from "./products.routes";
import sucursalesRoutes from "./sucursales.routes";
import zonasRoutes from "./zonas.routes";
import jornadasRoutes from "./jornadas.routes";
import inventariosRoutes from "./inventarios.routes";
import ticketsRoutes from "./tickets.routes";
import cortesRoutes from "./cortes.routes";
import usersRoutes from "./users.routes";
import detalleVentaRoutes from "./detalle-venta.routes";

const router = Router();

// GET / (equivale a GET /api) -> health/links
router.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    service: "POS Concesiones Estadio - API",
    status: "ok",
    timestamp: new Date().toISOString(),
    docs: "/api-docs",
  });
});

router.use("/auth", authRoutes);
router.use("/concessions", concessionsRoutes);
router.use("/products", productsRoutes);
router.use("/sucursales", sucursalesRoutes);
router.use("/zonas", zonasRoutes);
router.use("/jornadas", jornadasRoutes);
router.use("/inventarios", inventariosRoutes);
router.use("/tickets", ticketsRoutes);
router.use("/cortes", cortesRoutes);
router.use("/users", usersRoutes);
router.use("/detalle-venta", detalleVentaRoutes);

export default router;
