import { Router } from "express";
import * as q from "../controllers/jornadas/jornadas.query.controller";
import { authMiddleware } from "../utils/middlewares";

const router = Router();

router.get("/activa", authMiddleware, q.getJornadaActiva);

export default router;
