import { createUserSchema, updateUserSchema } from "../src/middleware/validators/user.validator";

describe("user validators", () => {
    it("acepta concesionId y sucursalId al crear un VENDEDOR", () => {
        const parsed = createUserSchema.parse({
            nombre: "Ana",
            fecha_nacimiento: "1990-01-01",
            email: "ana@example.com",
            password: "123456",
            rol: "VENDEDOR",
            concesionId: "concession-1",
            sucursalId: "sucursal-1",
        });

        expect(parsed.concesionId).toBe("concession-1");
        expect(parsed.sucursalId).toBe("sucursal-1");
    });

    it("acepta concesionId al crear un ADMIN", () => {
        const parsed = createUserSchema.parse({
            nombre: "Admin",
            fecha_nacimiento: "1990-01-01",
            email: "admin@example.com",
            password: "123456",
            rol: "ADMIN",
            concesionId: "concession-1",
        });

        expect(parsed.concesionId).toBe("concession-1");
    });

    it("rechaza VENDEDOR sin sucursalId", () => {
        expect(() =>
            createUserSchema.parse({
                nombre: "Ana",
                fecha_nacimiento: "1990-01-01",
                email: "ana@example.com",
                password: "123456",
                rol: "VENDEDOR",
                concesionId: "concession-1",
            }),
        ).toThrow();
    });

    it("acepta concesionId al actualizar un usuario", () => {
        const parsed = updateUserSchema.parse({
            concesionId: "concession-2",
        });

        expect(parsed.concesionId).toBe("concession-2");
    });
});
