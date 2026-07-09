# CI/CD — Firebase Cloud Functions (PuntoVentaConcesionBackend)

Documentación del pipeline de integración y despliegue continuo del backend POS de concesiones del Club León.

## Arquitectura del pipeline

```text
pull_request → main | develop ──► job: quality (tests + build)
push         → develop          ──► job: quality (sin deploy)
push/merge   → main             ──► job: quality ──► job: deploy-production
```

- **Workflow:** `.github/workflows/backend-ci.yml`
- **Repositorio:** [ZurielMO/PuntoVentaConcesionBackend](https://github.com/ZurielMO/PuntoVentaConcesionBackend)
- **Rama por defecto:** `main`
- **Directorio de Functions:** `functions/` (definido en `firebase.json`)
- **Función exportada:** `api` (Firebase Cloud Functions v2 / `onRequest`)
- **Región de despliegue:** `us-central1` (predeterminada de Firebase CLI para este proyecto)
- **Runtime Node.js:** 22 (`functions/package.json`)

### Job `quality`

Se ejecuta en:

- pull requests hacia `main` o `develop`
- push a `main` o `develop`

Pasos: `npm ci` → `npm test` → `npm run build` en `functions/`.

No despliega. No ejecuta lint (el script sigue deshabilitado).

### Job `deploy-production`

- Depende de `quality`
- Solo en **push a `main`**
- Usa el environment de GitHub **`production`**
- Autenticación OIDC con Workload Identity Federation (sin claves JSON ni `FIREBASE_TOKEN`)
- Despliega únicamente: `firebase deploy --only functions`
- Concurrencia: grupo `backend-production`, sin cancelar despliegues en curso

## Proyecto Firebase

| Campo | Valor |
|-------|-------|
| Project ID | `puntoventacl` |
| Project number | `777547113836` |
| Display name | PuntoVentaCl |
| Estado | ACTIVE |

Configuración local: `.firebaserc` → `"default": "puntoventacl"`.

> **Nota:** En producción (al momento de esta documentación) la función `api` aparece desplegada como **v1 / nodejs20**. El código fuente ya usa **Functions v2** con Node 22; el próximo despliegue exitoso debería actualizar la generación.

## GitHub — environment y variables

### Environment `production`

Debe existir en **Settings → Environments → production** con:

- **Deployment branches:** solo `main`
- Opcional: revisores requeridos si el equipo ya usa aprobaciones de producción

### Variables de repositorio (no secrets)

Configurar en **Settings → Secrets and variables → Actions → Variables**:

| Variable | Descripción | Valor esperado |
|----------|-------------|----------------|
| `FIREBASE_PROJECT_ID` | ID del proyecto Firebase | `puntoventacl` |
| `WIF_PROVIDER` | Resource name completo del proveedor OIDC | `projects/777547113836/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID` |
| `WIF_SERVICE_ACCOUNT` | Email de la cuenta de servicio de despliegue | `github-actions-deployer@puntoventacl.iam.gserviceaccount.com` |

**No** guardar claves JSON, `FIREBASE_TOKEN` ni PAT de GitHub como credenciales de despliegue.

## Workload Identity Federation (Google Cloud)

Ver sección completa en el repositorio para comandos `gcloud` de pool OIDC, cuenta de servicio y roles IAM de mínimo privilegio.

## Secretos de runtime

El backend consume variables de entorno (`process.env`); no usa `defineSecret` ni `functions.config()` actualmente.

Secretos sensibles que deben existir en Firebase/Google Cloud (solo nombres):

- `JWT_SECRET`
- `FIREBASE_API_KEY` / `CLIENT_FIREBASE_API_KEY` / `AUTH_API_KEY` / `WEB_API_KEY`
- `SERVICE_ACCOUNT_APP_OFICIAL` / `SERVICE_ACCOUNT_APP_OFICIAL_PATH`
- `SERVICE_ACCOUNT_APP_OFICIAL2` / `SERVICE_ACCOUNT_APP_OFICIAL2_PATH`
- `CONCESSION_POINTS_SOURCE_SECRET` / `ORIGIN_ID_SECRET`
- `BACKENDCL_BEARER_TOKEN`
- `BACKENDCL_AUTH_EMAIL` / `BACKENDCL_AUTH_PASSWORD`

**Deuda técnica:** Configurar ESLint real y agregarlo como quality gate.

## Validación local

Desde `functions/`:

```bash
npm ci
npm test
npm run build
```

## Verificación post-despliegue

```text
GET https://us-central1-puntoventacl.cloudfunctions.net/api
```

## Rollback

Revertir vía PR a `main` y dejar que el pipeline redepliegue la versión anterior.
