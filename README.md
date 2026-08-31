# PuntoVentaBack

Cascarón (boilerplate base) para el backend de **PuntoVenta**. Replica la
arquitectura y el tooling del backend de referencia, pero **sin** la lógica de
negocio específica: queda listo para empezar a implementar tus propios módulos
(productos, ventas, inventario, etc.).

## Stack

- Node.js + TypeScript
- Firebase Cloud Functions (v2 HTTPS)
- Express 4
- Firebase Admin SDK (Firestore + Storage)
- Utilidades base: `helmet`, `cors`, `morgan`, `swagger-ui-express` + `swagger-jsdoc`, `zod`, `dotenv`, `jsonwebtoken`, `uuid`

## Estructura

```
PuntoVentaBack/
├── .firebaserc                  # project id de Firebase (placeholder)
├── firebase.json                # functions + firestore + storage + emuladores
├── firestore.rules              # deny-by-default
├── firestore.indexes.json       # vacío (agrega índices según el dominio)
├── storage.rules                # deny-by-default
├── package.json                 # wrapper de scripts hacia functions/
└── functions/
    ├── .env.example             # plantilla de variables (sin secretos reales)
    ├── jest.config.js
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts             # export de la Cloud Function `api`
    │   ├── app.ts               # bootstrap de Express (CORS, helmet, swagger, errores)
    │   ├── dev.ts               # servidor local de desarrollo
    │   ├── config/
    │   │   ├── env.bootstrap.ts  # carga de .env / .env.local
    │   │   ├── firebase.admin.ts # inicialización de Firebase Admin (parametrizada por env)
    │   │   ├── firebase.ts       # firestore + storage
    │   │   ├── firestore.constants.ts
    │   │   ├── cors.config.ts
    │   │   └── swagger.config.ts
    │   ├── controllers/
    │   │   └── health/health.controller.ts   # ejemplo mínimo { status: "ok" }
    │   ├── middleware/
    │   │   ├── request-context.middleware.ts  # x-request-id
    │   │   └── validators/.gitkeep            # placeholder
    │   ├── models/.gitkeep                     # placeholder
    │   ├── routes/
    │   │   ├── index.ts          # hub central de rutas
    │   │   └── health.routes.ts
    │   ├── services/.gitkeep                   # placeholder
    │   ├── types/express.d.ts    # augmentación de Express.Request
    │   └── utils/
    │       ├── api-error.ts
    │       ├── error-handler.ts
    │       ├── public-error.util.ts
    │       └── middlewares.ts    # auth opcional + blockDebug (genéricos)
    └── tests/
        └── health.test.ts
```

Las carpetas `models/`, `services/` y `middleware/validators/` están vacías a
propósito (sólo con `.gitkeep`): son los lugares previstos para implementar el
dominio. El módulo `health` es el único ejemplo funcional incluido.

## Requisitos

- Node.js 22 (Cloud Functions). El wrapper raíz acepta Node >= 18.
- npm >= 9
- Firebase CLI (`npm i -g firebase-tools`) para emuladores/deploy.

## Instalación

```bash
# En la raíz del proyecto
npm install

# Dependencias de las Cloud Functions
cd functions && npm install
```

## Configuración de entorno

1. Copia la plantilla de variables:

```bash
cd functions
cp .env.example .env.local
```

2. Edita `functions/.env.local` con tus valores reales (no se commitea).
   Lo mínimo para arrancar en local es el puerto; para usar Firestore/Storage
   define `FIREBASE_PROJECT_ID` y `STORAGE_BUCKET`.
3. Para credenciales locales del Admin SDK puedes:
   - colocar un `serviceAccountKey.json` en la raíz del proyecto, o
   - definir `SERVICE_ACCOUNT_KEY` (JSON en una sola línea) en `.env.local`, o
   - usar Application Default Credentials / emuladores.

   **Nunca** subas secretos al repo; en producción usa Firebase Secret Manager.

## Configurar el proyecto de Firebase

Reemplaza el placeholder `your-firebase-project-id` por tu project id real en:

- `.firebaserc` → `projects.default`
- `functions/.env.example` / `.env.local` → `FIREBASE_PROJECT_ID`, `GCP_PROJECT_ID`, `STORAGE_BUCKET`
- `functions/src/config/swagger.config.ts` → host de ejemplo (opcional)

## Correr en local

```bash
# Desde la raíz
npm run dev
# o, con un puerto distinto si el 3000 está ocupado:
cd functions && npx cross-env PORT=3100 npm run dev
```

Verifica el health check:

```bash
curl http://localhost:3000/api/health
# { "status": "ok", "service": "puntoventa-back", ... }
```

Swagger UI (solo en desarrollo): `http://localhost:3000/api-docs`

## Scripts

| Script (raíz)     | Acción                                            |
|-------------------|---------------------------------------------------|
| `npm run dev`     | Servidor local con recarga (`ts-node-dev`)        |
| `npm run build`   | Compila TypeScript a `functions/lib`              |
| `npm run start`   | `firebase functions:shell` (requiere build)       |
| `npm run deploy`  | `firebase deploy --only functions`                |
| `npm run clean`   | Limpia `functions/lib`                            |

Dentro de `functions/` además: `npm test` (jest), `npm run serve` (emuladores).

## Backend VIP (pedidos a palco)

El API VIP reutiliza las colecciones reales `concesiones`, `products`,
`sucursales`, `zonas`, `inventarios` y `comprobantes_venta`. No mantiene un
catálogo ni inventario paralelo. Toda compra usa Stripe Hosted Checkout; solo
un webhook firmado confirma el pago y registra la venta.

### Configuración obligatoria en Firestore

Los IDs son referencias a documentos reales. El checkout **falla cerrado** si
falta alguno; este repositorio no incluye IDs ni datos mock de producción.

| Documento | Campos mínimos |
|---|---|
| `vip_service_configs/{jornadaId}` | `enabled: true`, `acceptingOrders: true`, `opensAt`/`closesAt` (Timestamp), `maxActiveOrders` (>0), `activeOrderCount` (iniciar en 0), `serviceFeeMinor` (por ejemplo 2000 para $20 MXN) |
| `vip_concession_config/{concessionIdReal}` | `enabled: true`, `sucursalId` (sucursal real de esa concesión) |
| `vip_product_config/{productIdReal}` | `enabled: true`, `concessionId` real, `options` y `extras` como arreglos de `{ id, name, price, active }`; opcionalmente `inventoryProductId`/`inventoryQuantity` para complementos que consumen stock |
| `vip_locations/{locationId}` | `activo: true`, `zonaId` real, `palco` y `nivel` oficiales |

`jornadaId` usa el mismo constructor del POS (`fecha` + número de jornada) y
debe corresponder a la jornada activa de `acreditaciones-b904f`. El catálogo
público solo devuelve concesiones/productos reales con configuración VIP
habilitada.

### Secretos y despliegue

Configura en Firebase Secret Manager:

```bash
npx firebase-tools functions:secrets:set STRIPE_SECRET_KEY --project puntoventacl
npx firebase-tools functions:secrets:set STRIPE_WEBHOOK_SECRET --project puntoventacl
npx firebase-tools functions:secrets:set VIP_TRACKING_SECRET --project puntoventacl
```

Configura también las URLs no secretas y demás variables documentadas en
`functions/.env.example`. Registra en Stripe el webhook público
`POST /vip/webhooks/stripe` para los eventos de Checkout/PaymentIntent. La ruta
raw se monta antes de `express.json()` para conservar la firma.

Despliega índices antes del piloto:

```bash
npx firebase-tools deploy --only firestore:indexes --project puntoventacl
```

Habilita políticas TTL de Firestore sobre `expiresAt` en
`vip_rate_limits` y `vip_idempotency` para limpiar buckets/claves vencidas. La
expiración funcional de inventario no depende del TTL: la función programada
`expireVipReservations` corre cada cinco minutos y libera reservas activas de
forma transaccional.

El rol existente `CONCESION_SUPERADMIN` (o claims admin existentes) puede ver
todas las órdenes. `CONCESION_ADMIN` y `CONCESION_ADMIN_CERVECERIA` usan los
mismos claims actuales y quedan limitados a órdenes que contengan su
`concesionId`; no se añadieron bypasses ni roles públicos. Roles futuros
`VIP_OPERATOR`/`VIP_RUNNER` no se aceptan hasta definirlos explícitamente en el
proveedor de identidad y su alcance.

### Migración segura de pedidos VIP anteriores

El script es de solo lectura por defecto y no inventa datos faltantes:

```bash
cd functions
npm run migrate:vip-orders
# tras revisar los IDs reportados:
npm run migrate:vip-orders -- --apply
```

`--apply` únicamente etiqueta documentos legacy para revisión manual. No
modifica pagos, clientes, ventas ni inventario.

## Deploy

> Configura primero tu project id (`.firebaserc`) y secretos. Luego:

```bash
cd functions && npm run build && cd .. && firebase deploy --only functions --project your-firebase-project-id
```

## Cómo agregar un módulo

1. Crea el controlador en `src/controllers/<modulo>/`.
2. Crea las rutas en `src/routes/<modulo>.routes.ts`.
3. Monta las rutas en `src/routes/index.ts` (`router.use("/<modulo>", ...)`).
4. (Opcional) Agrega validadores Zod en `src/middleware/validators/` y modelos en `src/models/`.
5. (Opcional) Documenta en Swagger con anotaciones `@openapi` en el archivo de rutas.
