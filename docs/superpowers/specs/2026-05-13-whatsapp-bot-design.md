# WhatsApp Bot — Both Company · Design Spec
Date: 2026-05-13

## Objetivo
Desplegar el bot de WhatsApp de Both Company en Railway con un panel web completo accesible desde el CRM, sesión persistente en Supabase, y handoff humano automático.

---

## Arquitectura

```
[WhatsApp] ←→ [Bot en Railway (Baileys)] ←→ [Supabase]
                        ↕ socket.io
               [Panel web en Railway]
                        ↑ link
               [CRM en Netlify] (sidebar)
```

- El bot corre en Railway como proceso Node.js 24/7
- Express sirve el panel web estático en `public/`
- Socket.io sincroniza conversaciones en tiempo real entre el bot y el panel
- La sesión de WhatsApp se persiste en Supabase (tabla `whatsapp_session`) para sobrevivir reinicios de Railway
- El CRM agrega "📱 WhatsApp" al sidebar de todas las páginas, abriendo el panel en nueva pestaña

---

## Sesión persistente en Supabase

**Tabla nueva:**
```sql
CREATE TABLE whatsapp_session (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Implementación:** Reemplazar `useMultiFileAuthState('./session')` por una función `useSupabaseAuthState(supabase)` que:
- Lee las credenciales desde `whatsapp_session` al arrancar
- Escribe cada actualización de credenciales a Supabase (evento `creds.update`)
- Si no hay sesión → el bot emite el QR vía socket.io para mostrarlo en el panel

---

## Panel web (`public/index.html`)

Diseño visual consistente con el CRM (mismos colores dorados, tipografía, estilo de tarjetas).

### Layout
```
┌──────────────────────────────────────────────────────┐
│ 🟢 Bot activo · Both Company WhatsApp                │ topbar
├─────────────────┬────────────────────────────────────┤
│ Lista           │ Card cliente + Chat + Controles     │
│ conversaciones  │                                     │
└─────────────────┴────────────────────────────────────┘
```

### Panel izquierdo — conversaciones
- Nombre del cliente (o teléfono si aún no identificado)
- Empresa debajo del nombre
- Preview del último mensaje (truncado)
- Badges de estado:
  - 🔔 Listo para cotizar (dorado) → cuando bot emite `cliente_listo`
  - ⚠️ Atención requerida (rojo) → cuando bot emite `atencion_requerida`
  - 🤖 Con bot / 👤 Contigo (indicador de quién tiene el control)
- Click en conversación → la abre en el panel derecho

### Panel derecho — chat activo
- **Card superior:** nombre, empresa, teléfono, enlace al perfil en el CRM
- **Burbujas de mensajes:**
  - Cliente → gris (alineado izquierda)
  - Bot → azul claro (alineado derecha)
  - Humano → dorado (alineado derecha)
- **Controles de handoff:**
  - Botón "Tomar control" → `tomadoPorHumano[jid] = true`, habilita input
  - Botón "Devolver al bot" → `tomadoPorHumano[jid] = false`, deshabilita input
- **Input de mensaje:** bloqueado mientras bot tiene control, activo cuando humano tiene control

### Estado desconectado
Cuando el bot emite el QR via socket.io:
- La topbar muestra 🔴 Bot desconectado
- Se muestra el QR como imagen (`api.qrserver.com`) en el centro del panel
- Instrucción: "Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo"
- Al reconectar → QR desaparece, vuelven las conversaciones

---

## Comportamiento de handoff

| Evento | Resultado |
|--------|-----------|
| Click "Tomar control" en panel | Bot pausa para ese cliente. Input habilitado. |
| Mensaje enviado desde el teléfono físico | Bot detecta `fromMe=true`, pausa automáticamente para ese cliente. |
| Click "Devolver al bot" | Bot retoma. Input deshabilitado. |

El handoff es **por conversación individual** — si tienes 3 chats activos, puedes tener el bot manejando 2 y tú atendiendo 1 al mismo tiempo.

---

## Respuestas del bot

- Usa Claude Haiku para velocidad y costo
- Da estimados de precio basados en `config-empresa.js` (ya configurado)
- No genera PDFs automáticamente — cuando el cliente quiere cotización formal, el humano toma control y la genera desde el cotizador
- Detecta `[ESTADO:LISTO_PARA_VENTA]` → emite `cliente_listo` al panel + notifica al número de ventas

---

## Variables de entorno (Railway)

| Variable | Valor |
|----------|-------|
| `ANTHROPIC_API_KEY` | Misma que el cotizador |
| `SUPABASE_URL` | Misma que el CRM |
| `SUPABASE_SERVICE_KEY` | Misma que el cotizador |
| `NUMERO_VENTAS` | Número WhatsApp del vendedor (formato: 50375859073) |
| `PORT` | Railway lo asigna automáticamente |

---

## Integración con CRM

- Agregar `<a href="{RAILWAY_URL}" target="_blank" class="nav-item">📱 WhatsApp</a>` al sidebar de todos los HTML del CRM
- La URL de Railway se configura una vez que el bot esté desplegado
- El link al perfil del cliente en el panel usa `/cliente-perfil.html?id={id}` del CRM

---

## Despliegue

1. Crear repo GitHub `bot-bothcompany`
2. Push del código actual
3. Crear nuevo proyecto en Railway → conectar el repo
4. Configurar variables de entorno en Railway
5. Railway despliega automáticamente
6. Abrir panel → escanear QR → bot activo
7. Actualizar sidebar del CRM con la URL de Railway → deploy Netlify

---

## Lo que NO hace (fuera de scope)

- Cotizaciones PDF automáticas desde WhatsApp
- Grupos de WhatsApp (solo chats individuales)
- Multimedia entrante (imágenes, audios) — solo texto
- Autenticación del panel (acceso libre por URL — la URL de Railway no es pública si no se comparte)
