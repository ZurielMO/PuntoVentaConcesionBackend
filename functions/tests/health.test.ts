import request from "supertest";
import app from "../src/app";

describe("GET /api (health)", () => {
  it("responde 200 con status ok", async () => {
    const response = await request(app).get("/api");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toContain("POS Concesiones Estadio");
  });

  it("responde 404 para rutas desconocidas", async () => {
    const response = await request(app).get("/api/ruta-inexistente");

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });
});
