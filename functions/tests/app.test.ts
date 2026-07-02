import request from "supertest";
import app from "../src/app";

describe("App / rutas base", () => {
  it("GET /api responde health", async () => {
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.service).toContain("POS Concesiones Estadio");
  });

  it("rutas protegidas sin token responden 401", async () => {
    const res = await request(app).get("/api/concessions");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("ruta inexistente responde 404", async () => {
    const res = await request(app).get("/api/no-existe-ruta");
    expect(res.status).toBe(404);
  });
});
