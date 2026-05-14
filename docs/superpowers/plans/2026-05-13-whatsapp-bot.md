# WhatsApp Bot — Both Company Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desplegar el bot de WhatsApp de Both Company en Railway con sesión persistente en Supabase, panel web completo para manejar conversaciones y handoff, e integración en el sidebar del CRM.

**Architecture:** La sesión de WhatsApp (Baileys) se persiste en la tabla `whatsapp_session` de Supabase, eliminando la necesidad de re-escanear el QR en cada reinicio de Railway. Un panel web (Express + Socket.io) sirve la UI en `public/index.html` y muestra conversaciones en tiempo real, handoff humano, y QR cuando se necesita reconectar. El CRM agrega un link "📱 WhatsApp" en el sidebar de todas sus páginas.

**Tech Stack:** Node.js 18+, @whiskeysockets/baileys, Express 5, Socket.io 4, @supabase/supabase-js, Anthropic Haiku, Railway, Netlify (CRM)

---

## Mapa de archivos

| Acción | Archivo | Responsabilidad |
|--------|---------|-----------------|
| CREAR | `lib/supabase-auth-state.js` | Auth state de Baileys que lee/escribe en Supabase |
| MODIFICAR | `index.js` | Usa supabase auth state, emite QR por socket, guarda clienteId |
| CREAR | `public/index.html` | Panel web: lista de chats, vista de conversación, handoff, QR |
| MODIFICAR | `.env.example` | Agregar CRM_URL |
| MODIFICAR | `CRM-BothCompany/*.html` (8 archivos) | Link WhatsApp en sidebar |

---

## Task 1: Tabla whatsapp_session en Supabase

**Archivos:** ninguno — SQL en Supabase dashboard

- [ ] **Paso 1: Correr en Supabase → SQL Editor**

```sql
CREATE TABLE IF NOT EXISTS whatsapp_session (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE whatsapp_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_ws" ON whatsapp_session FOR ALL USING (true);
```

- [ ] **Paso 2: Verificar**

Ir a Supabase → Table Editor → confirmar tabla `whatsapp_session` con columnas `key`, `value`, `updated_at`.

---

## Task 2: Crear lib/supabase-auth-state.js

**Archivos:**
- Crear: `lib/supabase-auth-state.js`

- [ ] **Paso 1: Crear carpeta lib**

```powershell
New-Item -ItemType Directory -Force -Path "lib"
```

- [ ] **Paso 2: Crear lib/supabase-auth-state.js**

```javascript
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys')

async function useSupabaseAuthState(supabase) {
  async function readData(key) {
    try {
      const { data } = await supabase
        .from('whatsapp_session')
        .select('value')
        .eq('key', key)
        .maybeSingle()
      if (!data) return null
      return JSON.parse(data.value, BufferJSON.reviver)
    } catch {
      return null
    }
  }

  async function writeData(key, value) {
    const json = JSON.stringify(value, BufferJSON.replacer)
    await supabase
      .from('whatsapp_session')
      .upsert({ key, value: json, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }

  async function removeData(key) {
    await supabase.from('whatsapp_session').delete().eq('key', key)
  }

  const creds = (await readData('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            let value = await readData(`${type}-${id}`)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            data[id] = value
          }
          return data
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}`
              if (value) await writeData(key, value)
              else await removeData(key)
            }
          }
        }
      }
    },
    saveCreds: () => writeData('creds', creds)
  }
}

module.exports = { useSupabaseAuthState }
```

- [ ] **Paso 3: Verificar sintaxis**

```powershell
node -e "require('./lib/supabase-auth-state')"
```

Esperado: sin output (sin errores de sintaxis).

- [ ] **Paso 4: Commit**

```powershell
git add lib/supabase-auth-state.js
git commit -m "feat: supabase auth state para sesion persistente de Baileys"
```

---

## Task 3: Actualizar index.js

**Archivos:**
- Modificar: `index.js`

Cuatro cambios: (1) importar `useSupabaseAuthState`, (2) agregar `CRM_URL`, (3) `guardarCliente` retorna el id, (4) emitir QR por socket.io.

- [ ] **Paso 1: Reemplazar import de baileys (línea 2)**

Reemplazar:
```javascript
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
```
Con:
```javascript
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { useSupabaseAuthState } = require('./lib/supabase-auth-state')
```

- [ ] **Paso 2: Agregar CRM_URL después de `const PORT = ...`**

```javascript
const CRM_URL = process.env.CRM_URL || 'https://crmbothcompany.netlify.app'
```

- [ ] **Paso 3: Reemplazar la función guardarCliente completa**

```javascript
async function guardarCliente(telefono, nombre, empresaNombre) {
  try {
    const { data: existente } = await supabase
      .from('clientes')
      .select('id, nombre, empresa')
      .eq('telefono', telefono)
      .maybeSingle()

    if (!existente) {
      const { data: nuevo } = await supabase
        .from('clientes')
        .insert({ nombre: nombre || telefono, telefono, fuente: 'whatsapp' })
        .select('id')
        .single()
      console.log(`Nuevo cliente en CRM: ${nombre || telefono}`)
      return nuevo?.id || null
    } else {
      if (empresaNombre && !existente.empresa) {
        await supabase.from('clientes')
          .update({ nombre: nombre || existente.nombre, empresa: empresaNombre })
          .eq('telefono', telefono)
        console.log(`Cliente actualizado: ${nombre} — ${empresaNombre}`)
      }
      return existente.id
    }
  } catch (e) {
    console.error('Error Supabase:', e.message)
    return null
  }
}
```

- [ ] **Paso 4: Usar el id retornado en procesarMensaje**

Buscar en `procesarMensaje`:
```javascript
if (esNuevo) await guardarCliente(telefono, pushName, null)
```
Reemplazar con:
```javascript
if (esNuevo) {
  const clienteId = await guardarCliente(telefono, pushName, null)
  if (clienteId) contactosInfo[jid] = { ...contactosInfo[jid], clienteId }
}
```

- [ ] **Paso 5: Emitir QR via socket.io en conectarWhatsApp**

Dentro del bloque `if (qr)` en `whatsappSock.ev.on('connection.update', ...)`, agregar esta línea después del `console.log` existente:
```javascript
io.emit('qr_disponible', `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`)
```

- [ ] **Paso 6: Reemplazar useMultiFileAuthState en conectarWhatsApp**

Buscar:
```javascript
const { state, saveCreds } = await useMultiFileAuthState('./session')
```
Reemplazar con:
```javascript
const { state, saveCreds } = await useSupabaseAuthState(supabase)
```

- [ ] **Paso 7: Commit**

```powershell
git add index.js
git commit -m "feat: sesion supabase, QR por socket.io, clienteId en contactosInfo"
```

---

## Task 4: Crear public/index.html

**Archivos:**
- Crear: `public/index.html`

- [ ] **Paso 1: Crear public/index.html**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Panel — Both Company</title>
  <style>
    :root { --gold:#C4923A; --gold-dark:#A67C2E; --gold-light:#FDF5E6; --panel-w:300px; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f5f7fa; color:#2d3748; height:100vh; display:flex; flex-direction:column; }

    .topbar { background:#fff; border-bottom:1px solid #e8e3dc; padding:12px 20px; display:flex; align-items:center; gap:12px; flex-shrink:0; }
    .topbar-logo { font-weight:800; font-size:15px; color:#2d1f0e; }
    .topbar-sub { font-size:13px; color:#718096; }
    .bot-status { display:flex; align-items:center; gap:6px; margin-left:auto; font-size:13px; font-weight:500; }
    .status-dot { width:10px; height:10px; border-radius:50%; background:#9ca3af; }
    .status-dot.on { background:#16a34a; }
    .status-dot.off { background:#dc2626; animation:pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }

    .layout { display:flex; flex:1; overflow:hidden; }

    .conv-list { width:var(--panel-w); background:#fff; border-right:1px solid #e8e3dc; display:flex; flex-direction:column; overflow:hidden; flex-shrink:0; }
    .conv-list-header { padding:14px 16px; font-size:12px; font-weight:700; color:#718096; text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid #f0ede8; }
    .conv-list-body { flex:1; overflow-y:auto; }
    .conv-item { padding:12px 16px; border-bottom:1px solid #f0ede8; cursor:pointer; transition:background .12s; }
    .conv-item:hover { background:#fafafa; }
    .conv-item.active { background:var(--gold-light); border-left:3px solid var(--gold); }
    .conv-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:2px; }
    .conv-nombre { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:165px; }
    .conv-hora { font-size:11px; color:#9ca3af; flex-shrink:0; }
    .conv-empresa { font-size:11px; color:#718096; margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .conv-preview { font-size:12px; color:#9ca3af; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .conv-badges { display:flex; gap:4px; margin-top:5px; flex-wrap:wrap; }
    .badge { font-size:10px; font-weight:600; padding:2px 6px; border-radius:10px; }
    .badge-listo { background:var(--gold-light); color:var(--gold-dark); }
    .badge-atencion { background:#fef2f2; color:#dc2626; }
    .badge-humano { background:#eff6ff; color:#2563eb; }
    .badge-bot { background:#f0fdf4; color:#16a34a; }
    .empty-list { padding:32px 16px; text-align:center; color:#9ca3af; font-size:13px; }

    .chat-panel { flex:1; display:flex; flex-direction:column; overflow:hidden; }
    .chat-placeholder { flex:1; display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:14px; }

    .cliente-card { background:#fff; border-bottom:1px solid #e8e3dc; padding:14px 20px; display:flex; align-items:center; gap:14px; flex-shrink:0; }
    .cliente-avatar { width:42px; height:42px; border-radius:50%; background:var(--gold); color:#fff; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:700; flex-shrink:0; }
    .cliente-info { flex:1; min-width:0; }
    .cliente-nombre { font-size:15px; font-weight:700; }
    .cliente-empresa { font-size:12px; color:#718096; }
    .cliente-tel { font-size:12px; color:#9ca3af; margin-top:2px; }
    .crm-link { font-size:12px; color:var(--gold); text-decoration:none; font-weight:500; }
    .crm-link:hover { text-decoration:underline; }
    .btn-control { padding:8px 16px; border-radius:8px; border:none; cursor:pointer; font-size:13px; font-weight:600; transition:all .12s; white-space:nowrap; }
    .btn-tomar { background:var(--gold); color:#fff; }
    .btn-tomar:hover { background:var(--gold-dark); }
    .btn-devolver { background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; }
    .btn-devolver:hover { background:#dcfce7; }

    .chat-messages { flex:1; overflow-y:auto; padding:16px 20px; display:flex; flex-direction:column; gap:10px; }
    .msg { display:flex; flex-direction:column; max-width:72%; }
    .msg.cliente { align-self:flex-start; }
    .msg.bot, .msg.humano { align-self:flex-end; }
    .msg-burbuja { padding:9px 13px; border-radius:12px; font-size:13px; line-height:1.5; word-break:break-word; }
    .msg.cliente .msg-burbuja { background:#e2e8f0; color:#2d3748; border-radius:12px 12px 12px 2px; }
    .msg.bot .msg-burbuja { background:#dbeafe; color:#1e3a5f; border-radius:12px 12px 2px 12px; }
    .msg.humano .msg-burbuja { background:var(--gold); color:#fff; border-radius:12px 12px 2px 12px; }
    .msg-meta { font-size:10px; color:#9ca3af; margin-top:3px; padding:0 4px; }
    .msg.bot .msg-meta, .msg.humano .msg-meta { text-align:right; }

    .chat-input-area { background:#fff; border-top:1px solid #e8e3dc; padding:12px 20px; display:flex; gap:10px; flex-shrink:0; }
    .chat-input { flex:1; border:1px solid #e2e8f0; border-radius:10px; padding:10px 14px; font-size:13px; outline:none; resize:none; height:44px; font-family:inherit; transition:border-color .12s; }
    .chat-input:focus { border-color:var(--gold); }
    .chat-input:disabled { background:#f9fafb; color:#9ca3af; cursor:not-allowed; }
    .btn-send { background:var(--gold); color:#fff; border:none; border-radius:10px; padding:0 18px; font-size:13px; font-weight:600; cursor:pointer; transition:background .12s; }
    .btn-send:hover:not(:disabled) { background:var(--gold-dark); }
    .btn-send:disabled { background:#e2e8f0; color:#9ca3af; cursor:not-allowed; }

    .qr-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:100; align-items:center; justify-content:center; }
    .qr-overlay.visible { display:flex; }
    .qr-card { background:#fff; border-radius:16px; padding:36px 40px; text-align:center; max-width:380px; width:90%; }
    .qr-title { font-size:18px; font-weight:800; margin-bottom:8px; }
    .qr-sub { font-size:13px; color:#718096; margin-bottom:24px; line-height:1.6; }
    .qr-img { width:260px; height:260px; border-radius:8px; border:1px solid #e2e8f0; }
    .qr-steps { margin-top:20px; font-size:12px; color:#718096; line-height:2.2; }
  </style>
</head>
<body>

<div class="topbar">
  <div class="topbar-logo">Both Company</div>
  <div class="topbar-sub">Panel WhatsApp</div>
  <div class="bot-status">
    <div class="status-dot" id="status-dot"></div>
    <span id="status-text">Conectando...</span>
  </div>
</div>

<div class="layout">
  <div class="conv-list">
    <div class="conv-list-header">Conversaciones</div>
    <div class="conv-list-body" id="conv-list-body">
      <div class="empty-list">Sin conversaciones aún</div>
    </div>
  </div>

  <div class="chat-panel" id="chat-panel">
    <div class="chat-placeholder">Selecciona una conversación</div>
  </div>
</div>

<div class="qr-overlay" id="qr-overlay">
  <div class="qr-card">
    <div class="qr-title">Conectar WhatsApp</div>
    <div class="qr-sub">Escanea el código para activar el bot</div>
    <img class="qr-img" id="qr-img" src="" alt="QR">
    <div class="qr-steps">
      1. Abre WhatsApp en tu teléfono<br>
      2. Toca ⋮ → Dispositivos vinculados<br>
      3. Toca "Vincular dispositivo"<br>
      4. Apunta la cámara aquí
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io()
const CRM_URL = 'https://crmbothcompany.netlify.app'

let conversaciones = {}
let tomadoPorHumano = {}
let contactosInfo = {}
let clientesListos = new Set()
let clientesAtencion = new Set()
let jidActivo = null

function iniciales(nombre) {
  if (!nombre) return '?'
  return nombre.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2)
}

function fmtTel(jid) { return jid.replace('@s.whatsapp.net', '') }

function renderLista() {
  const body = document.getElementById('conv-list-body')
  const jids = Object.keys(conversaciones)
  if (!jids.length) {
    body.innerHTML = '<div class="empty-list">Sin conversaciones aún</div>'
    return
  }
  body.innerHTML = jids.map(jid => {
    const msgs = conversaciones[jid] || []
    const ultimo = msgs[msgs.length - 1]
    const info = contactosInfo[jid] || {}
    const nombre = info.nombre || fmtTel(jid)
    const tomado = tomadoPorHumano[jid]
    const badges = [
      clientesListos.has(jid) ? '<span class="badge badge-listo">🔔 Listo para cotizar</span>' : '',
      clientesAtencion.has(jid) ? '<span class="badge badge-atencion">⚠️ Atención</span>' : '',
      tomado ? '<span class="badge badge-humano">👤 Contigo</span>' : '<span class="badge badge-bot">🤖 Bot</span>'
    ].filter(Boolean).join('')
    return `
      <div class="conv-item${jid === jidActivo ? ' active' : ''}" onclick="abrirChat('${jid}')">
        <div class="conv-top">
          <div class="conv-nombre">${nombre}</div>
          <div class="conv-hora">${ultimo?.hora || ''}</div>
        </div>
        ${info.empresa ? `<div class="conv-empresa">${info.empresa}</div>` : ''}
        <div class="conv-preview">${ultimo?.texto || ''}</div>
        <div class="conv-badges">${badges}</div>
      </div>`
  }).join('')
}

function renderChat(jid) {
  const panel = document.getElementById('chat-panel')
  const info = contactosInfo[jid] || {}
  const nombre = info.nombre || fmtTel(jid)
  const tomado = tomadoPorHumano[jid]
  const msgs = conversaciones[jid] || []

  const burbujas = msgs.map(m => `
    <div class="msg ${m.de}">
      <div class="msg-burbuja">${m.texto}</div>
      <div class="msg-meta">${m.de === 'bot' ? '🤖' : m.de === 'humano' ? '👤 Tú' : '💬'} · ${m.hora}</div>
    </div>`).join('')

  panel.innerHTML = `
    <div class="cliente-card">
      <div class="cliente-avatar">${iniciales(nombre)}</div>
      <div class="cliente-info">
        <div class="cliente-nombre">${nombre}</div>
        ${info.empresa ? `<div class="cliente-empresa">${info.empresa}</div>` : ''}
        <div class="cliente-tel">📱 +${fmtTel(jid)}</div>
        ${info.clienteId ? `<a href="${CRM_URL}/cliente-perfil.html?id=${info.clienteId}" target="_blank" class="crm-link">Ver perfil en CRM →</a>` : ''}
      </div>
      ${tomado
        ? `<button class="btn-control btn-devolver" onclick="devolverBot('${jid}')">🤖 Devolver al bot</button>`
        : `<button class="btn-control btn-tomar" onclick="tomarControl('${jid}')">✋ Tomar control</button>`}
    </div>
    <div class="chat-messages" id="chat-msgs">${burbujas}</div>
    <div class="chat-input-area">
      <textarea class="chat-input" id="msg-input"
        placeholder="${tomado ? 'Escribe tu respuesta...' : 'Toma el control para responder'}"
        ${tomado ? '' : 'disabled'}
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();enviarMensaje('${jid}')}"></textarea>
      <button class="btn-send" ${tomado ? '' : 'disabled'} onclick="enviarMensaje('${jid}')">Enviar</button>
    </div>`

  const el = document.getElementById('chat-msgs')
  if (el) el.scrollTop = el.scrollHeight
}

function abrirChat(jid) {
  jidActivo = jid
  clientesListos.delete(jid)
  clientesAtencion.delete(jid)
  renderLista()
  renderChat(jid)
}

function tomarControl(jid) {
  socket.emit('tomar_control', jid)
  tomadoPorHumano[jid] = true
  renderLista()
  renderChat(jid)
}

function devolverBot(jid) {
  socket.emit('devolver_bot', jid)
  tomadoPorHumano[jid] = false
  renderLista()
  renderChat(jid)
}

function enviarMensaje(jid) {
  const input = document.getElementById('msg-input')
  if (!input) return
  const texto = input.value.trim()
  if (!texto) return
  socket.emit('enviar_mensaje', { numero: jid, texto })
  input.value = ''
}

socket.on('conversaciones_iniciales', ({ conversaciones: c, tomadoPorHumano: t, contactosInfo: i }) => {
  conversaciones = c || {}
  tomadoPorHumano = t || {}
  contactosInfo = i || {}
  renderLista()
})

socket.on('bot_conectado', () => {
  document.getElementById('status-dot').className = 'status-dot on'
  document.getElementById('status-text').textContent = 'Bot activo'
  document.getElementById('qr-overlay').classList.remove('visible')
})

socket.on('bot_desconectado', () => {
  document.getElementById('status-dot').className = 'status-dot off'
  document.getElementById('status-text').textContent = 'Bot desconectado'
})

socket.on('qr_disponible', (url) => {
  document.getElementById('qr-img').src = url
  document.getElementById('qr-overlay').classList.add('visible')
  document.getElementById('status-dot').className = 'status-dot off'
  document.getElementById('status-text').textContent = 'Esperando QR...'
})

socket.on('nuevo_mensaje', ({ numero, mensaje, info }) => {
  if (!conversaciones[numero]) conversaciones[numero] = []
  conversaciones[numero].push(mensaje)
  if (info) contactosInfo[numero] = { ...contactosInfo[numero], ...info }
  renderLista()
  if (numero === jidActivo) renderChat(numero)
})

socket.on('cliente_listo', (jid) => {
  clientesListos.add(jid)
  renderLista()
})

socket.on('atencion_requerida', (jid) => {
  clientesAtencion.add(jid)
  renderLista()
})

socket.on('estado_actualizado', ({ numero, tomado }) => {
  tomadoPorHumano[numero] = tomado
  renderLista()
  if (numero === jidActivo) renderChat(numero)
})

socket.on('contacto_actualizado', ({ numero, info }) => {
  contactosInfo[numero] = { ...contactosInfo[numero], ...info }
  renderLista()
  if (numero === jidActivo) renderChat(numero)
})
</script>
</body>
</html>
```

- [ ] **Paso 2: Commit**

```powershell
git add public/index.html
git commit -m "feat: panel web completo con chat, handoff y QR overlay"
```

---

## Task 5: Actualizar .env.example

**Archivos:**
- Modificar: `.env.example`

- [ ] **Paso 1: Reemplazar .env.example**

```
# Clave de API de Claude (console.anthropic.com)
ANTHROPIC_API_KEY=sk-ant-api03-...

# Supabase — Project Settings > API
SUPABASE_URL=https://xxxxxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Número WhatsApp del equipo de ventas (código país + número, sin + ni espacios)
# Ejemplo El Salvador: 50375859073
NUMERO_VENTAS=50375859073

# URL del CRM (para links al perfil del cliente en el panel)
CRM_URL=https://crmbothcompany.netlify.app

# Puerto (Railway lo asigna automáticamente)
PORT=3000
```

- [ ] **Paso 2: Commit**

```powershell
git add .env.example
git commit -m "chore: agregar CRM_URL a variables documentadas"
```

---

## Task 6: GitHub repo y push

**Archivos:** ninguno — operaciones git

- [ ] **Paso 1: Verificar si ya existe repo git**

```powershell
git status
```

Si dice "not a git repository":
```powershell
git init
git add -A
git commit -m "feat: bot whatsapp both company"
```

Si ya existe repo, continuar al paso 2.

- [ ] **Paso 2: Crear repo en GitHub**

Ir a https://github.com/new →
- Nombre: `bot-bothcompany`
- Visibilidad: Private
- Sin README ni .gitignore (ya existen)

- [ ] **Paso 3: Conectar remote y hacer push**

```powershell
git remote add origin https://github.com/Caballero-CoderCreator/bot-bothcompany.git
git branch -M main
git push -u origin main
```

Esperado: "Branch 'main' set up to track remote branch 'main' from 'origin'"

---

## Task 7: Railway deploy

**Archivos:** ninguno — configuración en Railway dashboard

- [ ] **Paso 1: Crear proyecto en Railway**

Ir a https://railway.app → New Project → Deploy from GitHub repo → seleccionar `Caballero-CoderCreator/bot-bothcompany`

- [ ] **Paso 2: Configurar variables de entorno**

En el proyecto Railway → Variables → agregar una por una:

| Variable | Valor |
|----------|-------|
| `ANTHROPIC_API_KEY` | copiar del proyecto del cotizador en Railway |
| `SUPABASE_URL` | copiar de Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | copiar de Supabase → Project Settings → API (service_role) |
| `NUMERO_VENTAS` | tu número en formato `50375859073` (sin +, sin espacios) |
| `CRM_URL` | `https://crmbothcompany.netlify.app` |

- [ ] **Paso 3: Generar dominio público**

En Railway → Settings → Networking → Generate Domain → copiar la URL generada (ej: `bot-bothcompany-production.up.railway.app`)

- [ ] **Paso 4: Esperar deploy y abrir el panel**

Esperar ~2-3 minutos a que Railway termine el deploy. Abrir la URL generada en el navegador. Debe cargar el panel con el overlay del QR.

- [ ] **Paso 5: Escanear QR y conectar WhatsApp**

Con el teléfono: WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo → escanear el QR del panel. El overlay desaparece y el punto verde aparece en el topbar.

- [ ] **Paso 6: Probar con un mensaje**

Desde otro teléfono, enviar un mensaje al número de WhatsApp conectado. Verificar:
- Aparece en el panel izquierdo con el nombre/teléfono
- El bot responde automáticamente en WhatsApp
- El mensaje del bot aparece en el chat del panel

---

## Task 8: Link WhatsApp en CRM + deploy Netlify

**Archivos:**
- Modificar: los 8 HTML del CRM (reemplazar `{RAILWAY_URL}` con la URL real del paso 7.3)

- [ ] **Paso 1: Agregar link WhatsApp al sidebar en los 8 HTML del CRM**

En cada archivo, dentro de `<nav class="sidebar-nav">`, agregar después del link de Tareas:

```html
<a href="https://{RAILWAY_URL}" target="_blank" class="nav-item"><span class="nav-icon">📱</span> WhatsApp</a>
```

Archivos a modificar:
- `CRM-BothCompany/dashboard.html`
- `CRM-BothCompany/clientes.html`
- `CRM-BothCompany/cotizaciones.html`
- `CRM-BothCompany/pedidos.html`
- `CRM-BothCompany/pagos.html`
- `CRM-BothCompany/catalogo.html`
- `CRM-BothCompany/tareas.html`
- `CRM-BothCompany/cliente-perfil.html`

- [ ] **Paso 2: Deploy CRM a Netlify**

```powershell
cd "C:\Users\cabal\OneDrive\Desktop\Both Company Tools\CRM-BothCompany"
netlify deploy --prod --dir .
```

Esperado: `Deploy is live! · https://crmbothcompany.netlify.app`

- [ ] **Paso 3: Verificar integración completa**

Abrir https://crmbothcompany.netlify.app → sidebar muestra "📱 WhatsApp" → clic → abre el panel en nueva pestaña → punto verde → bot activo.
