import swaggerJsdoc from "swagger-jsdoc";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  loginSchema,
  loginPasswordSchema,
} from "../middleware/validators/auth.validator";
import {
  createConcessionSchema,
  replaceConcessionSchema,
  assignConcessionPointsSchema,
} from "../middleware/validators/concession.validator";
import {
  createProductSchema,
  updateProductSchema,
} from "../middleware/validators/product.validator";
import {
  createSucursalSchema,
  updateSucursalSchema,
} from "../middleware/validators/sucursal.validator";
import {
  createZonaSchema,
  updateZonaSchema,
} from "../middleware/validators/zona.validator";
import { upsertInventarioProductoSchema } from "../middleware/validators/inventario.validator";
import {
  createTicketSchema,
  updateTicketSchema,
} from "../middleware/validators/ticket.validator";
import {
  createCorteSchema,
  updateCorteSchema,
} from "../middleware/validators/corte.validator";
import {
  createUserSchema,
  updateUserSchema,
} from "../middleware/validators/user.validator";
import {
  createDetalleVentaSchema,
  updateDetalleVentaSchema,
} from "../middleware/validators/detalle-venta.validator";

const z2j: (schema: unknown) => any = (schema) =>
  zodToJsonSchema(schema as any, { target: "openApi3" });

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: ref(schemaName) } },
});

const ok = (description: string) => ({ description });
const bearer = [{ BearerAuth: [] as string[] }];

const idParam = {
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string" },
};

const swaggerDefinition = {
  openapi: "3.0.3",
  info: {
    title: "POS Concesiones Estadio - API",
    version: "1.0.0",
    description:
      "API REST para sistema de punto de venta (POS) de concesiones de estadio.",
  },
  servers: [
    { url: "/api", description: "Servidor actual" },
    {
      url: "{protocol}://{host}",
      description: "Servidor dinámico",
      variables: {
        protocol: { default: "https", enum: ["http", "https"] },
        host: {
          default: "us-central1-puntoventacl.cloudfunctions.net",
        },
      },
    },
  ],
  tags: [
    { name: "Authentication", description: "Autenticación (Firebase ID token)" },
    { name: "Concessions", description: "Concesiones" },
    { name: "Products", description: "Productos" },
    { name: "Sucursales", description: "Sucursales y cajas" },
    { name: "Zonas", description: "Zonas" },
    { name: "Jornadas", description: "Jornada activa (Realtime DB)" },
    { name: "Inventarios", description: "Inventarios por jornada" },
    { name: "Tickets", description: "Tickets (ventas)" },
    { name: "Cortes", description: "Cortes de caja" },
    { name: "Users", description: "Usuarios POS" },
    { name: "DetalleVenta", description: "Comprobantes de venta" },
  ],
  components: {
    securitySchemes: {
      BearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      Login: z2j(loginSchema),
      LoginPassword: z2j(loginPasswordSchema),
      CreateConcession: z2j(createConcessionSchema),
      ReplaceConcession: z2j(replaceConcessionSchema),
      AssignConcessionPoints: z2j(assignConcessionPointsSchema),
      CreateProduct: z2j(createProductSchema),
      UpdateProduct: z2j(updateProductSchema),
      CreateSucursal: z2j(createSucursalSchema),
      UpdateSucursal: z2j(updateSucursalSchema),
      CreateZona: z2j(createZonaSchema),
      UpdateZona: z2j(updateZonaSchema),
      UpsertInventarioProducto: z2j(upsertInventarioProductoSchema),
      CreateTicket: z2j(createTicketSchema),
      UpdateTicket: z2j(updateTicketSchema),
      CreateCorte: z2j(createCorteSchema),
      UpdateCorte: z2j(updateCorteSchema),
      CreateUser: z2j(createUserSchema),
      UpdateUser: z2j(updateUserSchema),
      CreateDetalleVenta: z2j(createDetalleVentaSchema),
      UpdateDetalleVenta: z2j(updateDetalleVentaSchema),
    },
  },
  paths: {
    "/": { get: { tags: ["Authentication"], summary: "Health", responses: { 200: ok("OK") } } },
    "/auth/login": {
      post: {
        tags: ["Authentication"],
        summary: "Login con Firebase ID token",
        requestBody: json("Login"),
        responses: { 200: ok("Login exitoso"), 401: ok("Token inválido") },
      },
    },
    "/auth/login/password": {
      post: {
        tags: ["Authentication"],
        summary: "Login email/password (DEV)",
        requestBody: json("LoginPassword"),
        responses: { 200: ok("Login exitoso"), 401: ok("Credenciales inválidas") },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Authentication"],
        summary: "Perfil actual",
        security: bearer,
        responses: { 200: ok("Perfil") },
      },
    },
    "/concessions": {
      get: {
        tags: ["Concessions"],
        summary: "Listar concesiones activas",
        security: bearer,
        responses: { 200: ok("Lista") },
      },
      post: {
        tags: ["Concessions"],
        summary: "Crear concesión",
        security: bearer,
        parameters: [{ in: "query", name: "idUser", schema: { type: "string" } }],
        requestBody: json("CreateConcession"),
        responses: { 201: ok("Creada") },
      },
    },
    "/concessions/asignarPuntosConsecion": {
      post: {
        tags: ["Concessions"],
        summary: "Asignar puntos por compra en concesión (typo intencional)",
        security: bearer,
        requestBody: json("AssignConcessionPoints"),
        responses: { 200: ok("Puntos asignados") },
      },
    },
    "/concessions/{id}": {
      get: { tags: ["Concessions"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK"), 404: ok("No encontrada") } },
      put: { tags: ["Concessions"], summary: "Reemplazar", security: bearer, parameters: [idParam], requestBody: json("ReplaceConcession"), responses: { 200: ok("OK") } },
      delete: { tags: ["Concessions"], summary: "Eliminar (soft)", security: bearer, parameters: [idParam], responses: { 204: ok("Eliminada") } },
    },
    "/concessions/{concesionId}/products": {
      get: { tags: ["Products"], summary: "Productos de concesión", security: bearer, parameters: [{ in: "path", name: "concesionId", required: true, schema: { type: "string" } }], responses: { 200: ok("Lista") } },
      post: { tags: ["Products"], summary: "Crear producto", security: bearer, parameters: [{ in: "path", name: "concesionId", required: true, schema: { type: "string" } }], requestBody: json("CreateProduct"), responses: { 201: ok("Creado") } },
    },
    "/products": { get: { tags: ["Products"], summary: "Listar productos activos", security: bearer, responses: { 200: ok("Lista") } } },
    "/products/{id}": {
      get: { tags: ["Products"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["Products"], summary: "Actualizar", security: bearer, parameters: [idParam], requestBody: json("UpdateProduct"), responses: { 200: ok("OK") } },
      delete: { tags: ["Products"], summary: "Eliminar (soft)", security: bearer, parameters: [idParam], responses: { 204: ok("Eliminado") } },
    },
    "/sucursales": {
      get: { tags: ["Sucursales"], summary: "Listar", security: bearer, responses: { 200: ok("Lista") } },
      post: { tags: ["Sucursales"], summary: "Crear", security: bearer, parameters: [{ in: "query", name: "concesion_id", required: true, schema: { type: "string" } }, { in: "query", name: "zona_id", required: true, schema: { type: "string" } }], requestBody: json("CreateSucursal"), responses: { 201: ok("Creada") } },
    },
    "/sucursales/{id}": {
      get: { tags: ["Sucursales"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["Sucursales"], summary: "Actualizar", security: bearer, parameters: [idParam], requestBody: json("UpdateSucursal"), responses: { 200: ok("OK") } },
      delete: { tags: ["Sucursales"], summary: "Eliminar (soft)", security: bearer, parameters: [idParam], responses: { 204: ok("Eliminada") } },
    },
    "/sucursales/{id}/cajas": { get: { tags: ["Sucursales"], summary: "Cajas de la sucursal", security: bearer, parameters: [idParam], responses: { 200: ok("Lista") } } },
    "/zonas": {
      get: { tags: ["Zonas"], summary: "Listar activas", security: bearer, responses: { 200: ok("Lista") } },
      post: { tags: ["Zonas"], summary: "Crear", security: bearer, requestBody: json("CreateZona"), responses: { 201: ok("Creada") } },
    },
    "/zonas/{id}": {
      get: { tags: ["Zonas"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["Zonas"], summary: "Actualizar", security: bearer, parameters: [idParam], requestBody: json("UpdateZona"), responses: { 200: ok("OK") } },
      delete: { tags: ["Zonas"], summary: "Eliminar (soft)", security: bearer, parameters: [idParam], responses: { 204: ok("Eliminada") } },
    },
    "/jornadas/activa": { get: { tags: ["Jornadas"], summary: "Jornada activa", security: bearer, responses: { 200: ok("OK"), 503: ok("Sin credenciales RTDB") } } },
    "/inventarios": { get: { tags: ["Inventarios"], summary: "Listar", security: bearer, parameters: [{ in: "query", name: "includeProductos", schema: { type: "boolean" } }], responses: { 200: ok("Lista") } } },
    "/inventarios/jornadas/{jornadaNumero}/fechas/{fechaJornada}/sucursales/{sucursalId}": {
      post: { tags: ["Inventarios"], summary: "Crear inventario", security: bearer, parameters: [{ in: "path", name: "jornadaNumero", required: true, schema: { type: "string" } }, { in: "path", name: "fechaJornada", required: true, schema: { type: "string" } }, { in: "path", name: "sucursalId", required: true, schema: { type: "string" } }], responses: { 201: ok("Creado") } },
    },
    "/inventarios/{id}": {
      get: { tags: ["Inventarios"], summary: "Obtener", security: bearer, parameters: [idParam, { in: "query", name: "includeProductos", schema: { type: "boolean" } }], responses: { 200: ok("OK") } },
      delete: { tags: ["Inventarios"], summary: "Eliminar (soft)", security: bearer, parameters: [idParam], responses: { 204: ok("Eliminado") } },
    },
    "/inventarios/{id}/productos": { get: { tags: ["Inventarios"], summary: "Productos del inventario", security: bearer, parameters: [idParam], responses: { 200: ok("Lista") } } },
    "/inventarios/{id}/productos/{productoId}": {
      get: { tags: ["Inventarios"], summary: "Obtener producto", security: bearer, parameters: [idParam, { in: "path", name: "productoId", required: true, schema: { type: "string" } }], responses: { 200: ok("OK") } },
      put: { tags: ["Inventarios"], summary: "Upsert producto", security: bearer, parameters: [idParam, { in: "path", name: "productoId", required: true, schema: { type: "string" } }], requestBody: json("UpsertInventarioProducto"), responses: { 200: ok("OK") } },
      delete: { tags: ["Inventarios"], summary: "Eliminar producto", security: bearer, parameters: [idParam, { in: "path", name: "productoId", required: true, schema: { type: "string" } }], responses: { 204: ok("Eliminado") } },
    },
    "/tickets": {
      get: { tags: ["Tickets"], summary: "Listar", security: bearer, responses: { 200: ok("Lista") } },
      post: { tags: ["Tickets"], summary: "Crear", security: bearer, parameters: [{ in: "query", name: "idUser", schema: { type: "string" } }], requestBody: json("CreateTicket"), responses: { 201: ok("Creado") } },
    },
    "/tickets/{id}": {
      get: { tags: ["Tickets"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["Tickets"], summary: "Actualizar", security: bearer, parameters: [idParam], requestBody: json("UpdateTicket"), responses: { 200: ok("OK") } },
    },
    "/cortes": {
      get: { tags: ["Cortes"], summary: "Listar", security: bearer, responses: { 200: ok("Lista") } },
      post: { tags: ["Cortes"], summary: "Crear", security: bearer, parameters: [{ in: "query", name: "idventa", schema: { type: "string" } }, { in: "query", name: "idUser", schema: { type: "string" } }], requestBody: json("CreateCorte"), responses: { 201: ok("Creado") } },
    },
    "/cortes/{id}": {
      get: { tags: ["Cortes"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["Cortes"], summary: "Actualizar", security: bearer, parameters: [idParam], requestBody: json("UpdateCorte"), responses: { 200: ok("OK") } },
    },
    "/users": {
      get: { tags: ["Users"], summary: "Listar (incluye inactivos)", security: bearer, responses: { 200: ok("Lista") } },
      post: { tags: ["Users"], summary: "Crear (SUPERADMIN)", security: bearer, requestBody: json("CreateUser"), responses: { 201: ok("Creado") } },
    },
    "/users/{id}": {
      get: { tags: ["Users"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["Users"], summary: "Actualizar", security: bearer, parameters: [idParam], requestBody: json("UpdateUser"), responses: { 200: ok("OK") } },
      delete: { tags: ["Users"], summary: "Eliminar (soft)", security: bearer, parameters: [idParam], responses: { 204: ok("Eliminado") } },
    },
    "/detalle-venta/ventas/{ventaId}/concesiones/{concesionId}/sucursales/{sucursalId}/inventarios/{inventarioId}": {
      post: { tags: ["DetalleVenta"], summary: "Crear comprobante", security: bearer, parameters: [{ in: "path", name: "ventaId", required: true, schema: { type: "string" } }, { in: "path", name: "concesionId", required: true, schema: { type: "string" } }, { in: "path", name: "sucursalId", required: true, schema: { type: "string" } }, { in: "path", name: "inventarioId", required: true, schema: { type: "string" } }], requestBody: json("CreateDetalleVenta"), responses: { 201: ok("Creado") } },
    },
    "/detalle-venta/{id}": {
      get: { tags: ["DetalleVenta"], summary: "Obtener", security: bearer, parameters: [idParam], responses: { 200: ok("OK") } },
      put: { tags: ["DetalleVenta"], summary: "Actualizar productos", security: bearer, parameters: [idParam], requestBody: json("UpdateDetalleVenta"), responses: { 200: ok("OK") } },
    },
  },
};

const swaggerOptions: swaggerJsdoc.Options = {
  definition: swaggerDefinition as swaggerJsdoc.Options["definition"],
  apis: [],
};

export const getSwaggerSpec = (): object => swaggerJsdoc(swaggerOptions);

export default swaggerDefinition;
