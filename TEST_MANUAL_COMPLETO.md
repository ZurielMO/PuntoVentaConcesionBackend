# 🧪 Test Manual - Flujo Completo de Concesión + Usuario

Este documento te guía para validar que todo funciona correctamente con requests reales.

---

## 📋 Requisitos

1. **Herramienta**: Postman, Insomnia, o `curl`
2. **Tokens**: Necesitarás un token SUPERADMIN válido
3. **Base URL**: `http://localhost:5001/api` (o tu URL de Firebase Functions)

---

## 🔐 Paso 0: Obtener Tokens de Prueba

### Opción A: Con Postman
1. Abre tu colección de Firebase
2. Ve a `Authorization` → `OAuth 2.0`
3. Usa las credenciales de tu Firebase project
4. El token aparecerá en `Authorization` header

### Opción B: Con CLI de Firebase
```bash
firebase auth:export ./users.json --project acreditaciones-b904f
```

### Opción C: Hardcodeado para pruebas
En `dev.ts` o environment local, puedes inyectar un token mock

---

## ✅ Test 1: Crear Concesión

**Método**: POST  
**URL**: `/concessions`  
**Header**: `Authorization: Bearer {SUPERADMIN_TOKEN}`

**Body**:
```json
{
  "nombre": "Test Stadium Concession",
  "imagenes": [],
  "activo": true
}
```

**Respuesta esperada (201)**:
```json
{
  "success": true,
  "data": {
    "id": "concession-abc123",
    "nombre": "Test Stadium Concession",
    "activo": true,
    "imagenes": [],
    "idUser": null,
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

**Guarda**: `CONCESSION_ID = "concession-abc123"`

---

## ✅ Test 2: Crear Usuario ADMIN

**Método**: POST  
**URL**: `/users`  
**Header**: `Authorization: Bearer {SUPERADMIN_TOKEN}`

**Body**:
```json
{
  "nombre": "Erik Test Admin",
  "fecha_nacimiento": "1990-05-15",
  "email": "erik.test@example.com",
  "password": "SecurePassword123!",
  "rol": "ADMIN",
  "concesionId": "concession-abc123"
}
```

**Respuesta esperada (201)**:
```json
{
  "success": true,
  "data": {
    "id": "user-xyz789",
    "uid": "firebase-uid-12345",
    "nombre": "Erik Test Admin",
    "email": "erik.test@example.com",
    "rol": "ADMIN",
    "concesionId": "concession-abc123",
    "activo": true,
    "createdAt": "2024-01-15T10:31:00Z",
    "updatedAt": "2024-01-15T10:31:00Z"
  }
}
```

**Guarda**: `USER_ID = "user-xyz789"`

---

## ✅ Test 3: Asignar Usuario a Concesión

> **CRÍTICO**: Este paso sincroniza ambos documentos (bidireccional)

**Método**: PUT  
**URL**: `/concessions/{CONCESSION_ID}/assign-user`  
**Ejemplo URL**: `/concessions/concession-abc123/assign-user`  
**Header**: `Authorization: Bearer {SUPERADMIN_TOKEN}`

**Body**:
```json
{
  "userId": "user-xyz789"
}
```

**Respuesta esperada (200)**:
```json
{
  "success": true,
  "data": {
    "id": "concession-abc123",
    "nombre": "Test Stadium Concession",
    "idUser": "user-xyz789",
    "activo": true,
    "imagenes": [],
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:32:00Z"
  }
}
```

**Valida que**:
- ✅ `idUser` ahora apunta a `user-xyz789`
- ✅ El timestamp `updatedAt` cambió

---

## ✅ Test 4: Verificar Usuario Tiene Concesión

> Confirma que el usuario se sincronizó correctamente

**Método**: GET  
**URL**: `/users/{USER_ID}`  
**Ejemplo URL**: `/users/user-xyz789`  
**Header**: `Authorization: Bearer {SUPERADMIN_TOKEN}`

**Respuesta esperada (200)**:
```json
{
  "success": true,
  "data": {
    "id": "user-xyz789",
    "uid": "firebase-uid-12345",
    "nombre": "Erik Test Admin",
    "email": "erik.test@example.com",
    "rol": "ADMIN",
    "concesionId": "concession-abc123",
    "activo": true,
    "createdAt": "2024-01-15T10:31:00Z",
    "updatedAt": "2024-01-15T10:31:00Z"
  }
}
```

**Valida que**:
- ✅ `concesionId` está presente y es `concession-abc123`

---

## ✅ Test 5: Login del Usuario ADMIN

**Método**: POST  
**URL**: `/auth/login`  
**Header**: `Content-Type: application/json`

**Body**:
```json
{
  "email": "erik.test@example.com",
  "password": "SecurePassword123!"
}
```

**Respuesta esperada (200)**:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": "user-xyz789",
      "uid": "firebase-uid-12345",
      "nombre": "Erik Test Admin",
      "email": "erik.test@example.com",
      "rol": "ADMIN",
      "concesionId": "concession-abc123",
      "activo": true
    }
  }
}
```

**Guarda**: `ADMIN_TOKEN = "eyJhbGciOiJIUzI1NiIs..."`

**Valida que**:
- ✅ Token incluye `concesionId` en el payload
- ✅ El usuario está activo

---

## ✅ Test 6: ADMIN Crea Producto

> **IMPORTANTE**: Este es el test que fallaba antes de la solución

**Método**: POST  
**URL**: `/products`  
**Header**: `Authorization: Bearer {ADMIN_TOKEN}`

**Body**:
```json
{
  "nombre": "Cerveza Premium",
  "descripcion": "Cerveza artesanal 600ml",
  "precio": 5500,
  "activo": true,
  "concesionId": "concession-abc123"
}
```

**Respuesta esperada (201)**:
```json
{
  "success": true,
  "data": {
    "id": "product-123",
    "nombre": "Cerveza Premium",
    "descripcion": "Cerveza artesanal 600ml",
    "precio": 5500,
    "activo": true,
    "concesionId": "concession-abc123",
    "createdAt": "2024-01-15T10:35:00Z",
    "updatedAt": "2024-01-15T10:35:00Z"
  }
}
```

**Valida que**:
- ✅ El producto se crea correctamente
- ✅ No hay errores de autorización
- ✅ La concesión del producto coincide con la del usuario

---

## ✅ Test 7: ADMIN Ve Sus Productos

**Método**: GET  
**URL**: `/products?concesionId={CONCESSION_ID}`  
**Ejemplo URL**: `/products?concesionId=concession-abc123`  
**Header**: `Authorization: Bearer {ADMIN_TOKEN}`

**Respuesta esperada (200)**:
```json
{
  "success": true,
  "data": [
    {
      "id": "product-123",
      "nombre": "Cerveza Premium",
      "descripcion": "Cerveza artesanal 600ml",
      "precio": 5500,
      "activo": true,
      "concesionId": "concession-abc123",
      "createdAt": "2024-01-15T10:35:00Z",
      "updatedAt": "2024-01-15T10:35:00Z"
    }
  ]
}
```

**Valida que**:
- ✅ El producto está en la lista
- ✅ Solo ve sus propios productos (no de otras concesiones)

---

## ❌ Test 8: Validar Seguridad (No Debería Funcionar)

### 8a: ADMIN Intenta Ver Otra Concesión

**Método**: GET  
**URL**: `/products?concesionId=otra-concesion-456`  
**Header**: `Authorization: Bearer {ADMIN_TOKEN}`

**Respuesta esperada (403 Forbidden)**:
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "No tienes acceso a esta concesión"
  }
}
```

---

### 8b: Usuario Sin Concesión Intenta Crear Producto

> Crea un usuario ADMIN sin concesionId asignada

**Precondición**:
```json
{
  "nombre": "Usuario Huérfano",
  "email": "orphan@example.com",
  "rol": "ADMIN"
  // Sin concesionId
}
```

**Método**: POST  
**URL**: `/products`  
**Header**: `Authorization: Bearer {ORPHAN_ADMIN_TOKEN}`

**Body**:
```json
{
  "nombre": "Producto",
  "precio": 1000
}
```

**Respuesta esperada (400 Bad Request)**:
```json
{
  "success": false,
  "error": {
    "code": "MISSING_CONCESSION",
    "message": "Usuario no tiene concesión asignada"
  }
}
```

---

## 📊 Tabla de Verificación

| Test | Status | Validar |
|------|--------|---------|
| Crear Concesión | ✅ | `idUser` es null, tiene ID |
| Crear Usuario | ✅ | `concesionId` está presente |
| Asignar Usuario | ✅ | Concesión se actualiza, usuario se sincroniza |
| Verificar Usuario | ✅ | `concesionId` persiste |
| Login ADMIN | ✅ | Token incluye `concesionId` |
| Crear Producto | ✅ | No hay error de autorización |
| Ver Productos | ✅ | Filtra por concesión automáticamente |
| Seguridad | ✅ | No puede ver otras concesiones |

---

## 🐛 Troubleshooting

### "Token inválido" (401)
- Verifica que el token no expiró
- Confirma que usas el token completo (sin "Bearer " prefijo en el header automático)

### "Usuario no tiene rol ADMIN" en asignación
- El usuario debe tener exactamente `rol: "ADMIN"` (case-sensitive)
- "EMPLEADO" se convierte a "VENDEDOR", no funciona para asignación

### "Concesión no encontrada"
- Verifica que el ID de concesión es correcto
- Usa el ID del documento de Firestore, no el display name

### "No tienes acceso a esta concesión"
- El token del usuario debe incluir `concesionId`
- Confirma que ejecutaste el paso de asignación (Test 3)

### Producto se crea pero con otra concesión
- El middleware infiere la concesión del usuario
- No pases `concesionId` en el body si quieres que use la del usuario

---

## 📝 Notas Importantes

1. **Orden importa**: Debe crear concesión → usuario → asignar
2. **Token de Usuario**: Después de asignar, haz login para obtener el token actualizado
3. **Sincronización**: El endpoint de asignación actualiza AMBOS documentos
4. **Seguridad**: ADMIN solo ve su propia concesión, SUPERADMIN ve todas

---

**Última actualización**: 2024-01-15  
**Versión**: 1.0 - Flujo Completo
