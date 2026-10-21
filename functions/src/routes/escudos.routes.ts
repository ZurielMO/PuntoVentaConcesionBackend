import { Router } from "express";

const CREST_BUCKET = "acreditaciones-b904f.firebasestorage.app";

const router = Router();

/** PNG público del bucket de acreditaciones, servido por la API (el bucket no tiene CORS). */
router.get("/:file", async (req, res) => {
  const file = String(req.params.file ?? "").toLowerCase();
  if (!/^[a-z0-9]+\.png$/.test(file)) {
    res.status(400).json({ success: false, message: "Escudo no válido" });
    return;
  }

  try {
    const upstream = await fetch(
      `https://firebasestorage.googleapis.com/v0/b/${CREST_BUCKET}/o/${encodeURIComponent(file)}?alt=media`,
    );
    if (!upstream.ok) {
      res.status(404).json({ success: false, message: "Escudo no encontrado" });
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch {
    res.status(502).json({ success: false, message: "No se pudo leer el escudo" });
  }
});

export default router;
