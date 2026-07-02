# Flujo de Creación de Concesiones y Usuarios

## 📋 Flujo Recomendado (CORRECTO)

### Paso 1: SuperAdmin crea la Concesión
```http
POST /api/concessions
Authorization: Bearer <superadmin_token>
Content-Type: application/json

{
  "nombre": "Asados Victoria",
  "imagenes": ["url_imagen"],
  "activo": true
}
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "id": "concession-123",
    "nombre": "Asados Victoria",
    "activo": true,
    "imagenes": [],
    "idUser": null,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

### Paso 2: SuperAdmin crea el usuario ADMIN de esa Concesión
```http
POST /api/users
Authorization: Bearer <superadmin_token>
Content-Type: application/json

{
  "nombre": "Erik Zuriel Mora",
  "fecha_nacimiento": "1990-01-01",
  "email": "erik@example.com",
  "password": "secure123456",
  "rol": "ADMIN",
  "concesionId": "concession-123"
}
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "id": "user-admin-456",
    "uid": "firebase-uid",
    "nombre": "Erik Zuriel Mora",
    "email": "erik@example.com",
    "rol": "ADMIN",
    "concesionId": "concession-123",
    "activo": true,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

### Paso 3: SuperAdmin asigna el usuario ADMIN a la Concesión
*(Sincroniza ambos documentos)*

```http
PUT /api/concessions/concession-123/assign-user
Authorization: Bearer <superadmin_token>
Content-Type: application/json

{
  "userId": "user-admin-456"
}
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "id": "concession-123",
    "nombre": "Asados Victoria",
    "idUser": "user-admin-456",
    "activo": true,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

### Paso 4: Admin inicia sesión y puede operar

Ahora el ADMIN puede:
- ✅ Ver productos de su concesión
- ✅ Crear productos para su concesión
- ✅ Crear sucursales
- ✅ Crear usuarios VENDEDOR
- ✅ Ver inventarios
- ✅ etc.

---

## 🚫 Flujo Incorrecto (EVITAR)

### ❌ No hagas esto:
1. Crear un usuario ADMIN primero
2. Luego crear una concesión
3. Intentar asignar el usuario desde la UI

**Problema:** El usuario no tendrá `concesionId` en su documento, y aunque la concesión tenga `idUser`, ambos no estarán sincronizados. El token del usuario no incluirá la concesión.

---

## 🔄 Sincronización Manual

Si necesitas cambiar el admin de una concesión existente:

```http
PUT /api/concessions/:concesionId/assign-user
Authorization: Bearer <superadmin_token>
Content-Type: application/json

{
  "userId": "nuevo-usuario-admin-id"
}
```

Esto:
1. ✅ Actualiza `idUser` en la concesión
2. ✅ Actualiza `concesionId` en el usuario (sincronización bidireccional)
3. ✅ Valida que el usuario tenga rol ADMIN
4. ✅ Evita inconsistencias de datos

---

## 🎯 Reglas de Negocio

### SuperAdmin puede:
- Crear/actualizar/eliminar concesiones
- Crear usuarios ADMIN y VENDEDOR
- Asignar usuarios ADMIN a concesiones
- Ver todas las concesiones
- Ver todas las sucursales
- Ver todos los productos
- **NO puede** crear inventarios directamente

### Admin (de una concesión) puede:
- Ver su propia concesión
- Ver productos de su concesión
- Crear productos para su concesión
- Crear sucursales
- Crear usuarios VENDEDOR de su concesión
- Crear inventarios
- Hacer cortes

### Vendedor puede:
- Ver productos
- Hacer tickets (ventas)
- Ver inventarios
- Ver cortes
- Ver detalle de ventas

---

## ⚠️ Validaciones Implementadas

El sistema valida automáticamente:

1. **Concesión no sincronizada**: Si intentas acceder a una concesión sin tener `concesionId` en el usuario, se rechaza
2. **Creación de productos**: Debe tener concesión asignada
3. **Creación de sucursales**: Debe ser para tu concesión
4. **Normalización de roles**: "EMPLEADO" se convierte automáticamente a "VENDEDOR"
5. **Asignación de usuarios**: Solo SUPERADMIN puede asignar

---

## 🛠️ Endpoints Útiles

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/concessions` | POST | Crear concesión (SUPERADMIN) |
| `/api/concessions/:id/assign-user` | PUT | Asignar usuario admin a concesión (SUPERADMIN) |
| `/api/users` | POST | Crear usuario (SUPERADMIN/ADMIN limitado) |
| `/api/users` | GET | Listar usuarios (SUPERADMIN ve todos, ADMIN ve su concesión) |
| `/api/products` | GET | Listar productos (filtrado por concesión automático) |
| `/api/products` | POST | Crear producto (requiere concesión) |
| `/api/sucursales` | POST | Crear sucursal (requiere concesión) |

