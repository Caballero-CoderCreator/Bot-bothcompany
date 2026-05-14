require('dotenv').config()
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const { useSupabaseAuthState } = require('./lib/supabase-auth-state')
const { Boom } = require('@hapi/boom')
const pino = require('pino')
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const path = require('path')
const empresa = require('./config-empresa')

// ── Clientes API ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const PORT = process.env.PORT || 3000
const CRM_URL = process.env.CRM_URL || 'https://crmbothcompany.netlify.app'

// ── Estado en memoria ──
const conversaciones = {}
const tomadoPorHumano = {}
const contactosInfo = {}
const esperandoNombre = new Set()
const botRespondiendo = new Set()
let botListo = false
let whatsappSock = null
let ultimoQR = null
const lidToPhone = {}  // mapeo LID → teléfono real (poblado por contacts.upsert)

// ── Express + Socket.io ──
const app = express()
const server = http.createServer(app)
const io = new Server(server)
app.use(express.static(path.join(__dirname, 'public')))

// ── System prompt ──
const SYSTEM_PROMPT = `Eres el asistente virtual de ${empresa.nombre}, ${empresa.descripcion}.

Atendés clientes por WhatsApp con un tono ${empresa.tono}. Seguí estas reglas:

PRENDAS Y SERVICIOS:
${empresa.productos}

PRECIOS:
${empresa.precios}

POLÍTICA DE PRECIOS:
${empresa.politicaPrecios}

TIEMPOS DE ENTREGA:
${empresa.tiemposEntrega}

PREGUNTAS FRECUENTES:
${empresa.preguntasFrecuentes}

EJEMPLOS DE COTIZACIÓN:
${empresa.ejemplosCotizacion}

RESTRICCIONES:
${empresa.restricciones}

INSTRUCCIONES:
- Respondé en español, de forma directa y sin frases de relleno
- Máximo 3-4 líneas por respuesta
- Si el cliente da suficiente info, dá una cotización estimada usando la tabla de precios
- Si falta info para cotizar, preguntá lo necesario de forma natural
- Si no sabés algo, decí que un asesor puede confirmar

Al final de CADA respuesta agregá exactamente una de estas etiquetas:
- Si el cliente consulta información general → [ESTADO:CONSULTA]
- Si quiere cotización específica, tiene diseño listo, quiere hacer pedido o hablar con alguien → [ESTADO:LISTO_PARA_VENTA]`

// ── Resolver teléfono real desde JID ──
function resolverTelefono(jid) {
  if (jid.endsWith('@lid')) {
    return lidToPhone[jid] || null  // null si aún no sincronizado
  }
  return jid.replace('@s.whatsapp.net', '')
}

// ── Supabase ──
async function guardarCliente(telefono, nombre, empresaNombre) {
  try {
    const { data: existente } = await supabase
      .from('clientes')
      .select('id, nombre, empresa')
      .eq('telefono', telefono)
      .maybeSingle()

    if (!existente) {
      const { data: nuevo } = await supabase.from('clientes').insert({
        nombre: nombre || telefono,
        telefono,
        fuente: 'whatsapp'
      }).select('id').maybeSingle()
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

// ── Extrae nombre/empresa de un mensaje ──
async function extraerNombreEmpresa(texto) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Extrae nombre y empresa de este mensaje. Responde SOLO con JSON sin texto adicional.\n\nMensaje: "${texto}"\n\nResponde exactamente: {"nombre": "Juan", "empresa": "Mi Empresa"}\nSi no hay nombre pon null. Si no hay empresa pon null.`
      }]
    })
    const match = res.content[0].text.match(/\{[\s\S]*?\}/)
    return match ? JSON.parse(match[0]) : null
  } catch (e) {
    return null
  }
}

// ── Socket.io ──
io.on('connection', (socket) => {
  socket.emit('conversaciones_iniciales', { conversaciones, tomadoPorHumano, contactosInfo })
  if (botListo) socket.emit('bot_conectado')
  else if (ultimoQR) socket.emit('qr_disponible', ultimoQR)

  socket.on('tomar_control', (fromId) => {
    tomadoPorHumano[fromId] = true
    io.emit('estado_actualizado', { numero: fromId, tomado: true })
  })

  socket.on('devolver_bot', (fromId) => {
    tomadoPorHumano[fromId] = false
    io.emit('estado_actualizado', { numero: fromId, tomado: false })
  })

  socket.on('enviar_mensaje', async ({ numero, texto }) => {
    if (!whatsappSock) return
    try {
      botRespondiendo.add(numero)
      await whatsappSock.sendMessage(numero, { text: texto })
      botRespondiendo.delete(numero)
      const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      if (!conversaciones[numero]) conversaciones[numero] = []
      conversaciones[numero].push({ de: 'humano', texto, hora })
      io.emit('nuevo_mensaje', { numero, mensaje: { de: 'humano', texto, hora } })
    } catch (e) {
      console.error('Error enviando mensaje:', e.message)
    }
  })
})

// ── Procesar mensaje entrante ──
async function procesarMensaje(message, enTiempoReal = true) {
  const jid = message.key.remoteJid
  if (!jid || jid.includes('broadcast') || jid.endsWith('@g.us')) return

  const texto = message.message?.conversation
    || message.message?.extendedTextMessage?.text
    || ''

  const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })

  // Mensaje enviado desde el teléfono (respuesta manual)
  if (message.key.fromMe) {
    if (!enTiempoReal) return  // ignorar historial al reconectar
    if (!texto.trim()) return
    // Ignorar el eco que WhatsApp devuelve de los mensajes enviados por el bot
    if (botRespondiendo.has(jid)) return
    const msgsJid = conversaciones[jid] || []
    const ultimoBot = [...msgsJid].reverse().find(m => m.de === 'bot')
    if (ultimoBot && ultimoBot.texto === texto) return  // es el eco del bot, no una respuesta humana
    if (!tomadoPorHumano[jid]) {
      tomadoPorHumano[jid] = true
      io.emit('estado_actualizado', { numero: jid, tomado: true })
    }
    if (!conversaciones[jid]) conversaciones[jid] = []
    conversaciones[jid].push({ de: 'humano', texto, hora })
    io.emit('nuevo_mensaje', { numero: jid, mensaje: { de: 'humano', texto, hora } })
    return
  }

  if (!texto.trim()) return

  const telefonoReal = resolverTelefono(jid)
  const pushName = message.pushName || telefonoReal || jid
  const esNuevo = !conversaciones[jid]

  let clienteId = contactosInfo[jid]?.clienteId || null
  if (esNuevo) {
    // Usar teléfono real si disponible, si no usar el LID como identificador único
    const telefonoGuardar = telefonoReal || jid.replace('@lid', '').replace('@s.whatsapp.net', '')
    clienteId = await guardarCliente(telefonoGuardar, pushName, null)
  }

  contactosInfo[jid] = {
    telefono: telefonoReal,
    display: telefonoReal || pushName,
    nombre: contactosInfo[jid]?.nombre || pushName,
    empresa: contactosInfo[jid]?.empresa || '',
    clienteId: clienteId || contactosInfo[jid]?.clienteId || null
  }

  if (!conversaciones[jid]) conversaciones[jid] = []
  conversaciones[jid].push({ de: 'cliente', texto, hora })
  io.emit('nuevo_mensaje', { numero: jid, mensaje: { de: 'cliente', texto, hora }, info: contactosInfo[jid] })

  if (tomadoPorHumano[jid]) {
    io.emit('atencion_requerida', jid)
    return
  }

  // Si estamos esperando nombre/empresa
  if (esperandoNombre.has(jid)) {
    esperandoNombre.delete(jid)
    const extraido = await extraerNombreEmpresa(texto)
    if (extraido && (extraido.nombre || extraido.empresa)) {
      const nombre = extraido.nombre || pushName
      const emp = extraido.empresa || ''
      await guardarCliente(telefono, nombre, emp)
      contactosInfo[jid] = { display: telefono, nombre, empresa: emp }
      io.emit('contacto_actualizado', { numero: jid, info: contactosInfo[jid] })
    }
  }

  try {
    const promptFinal = esNuevo
      ? SYSTEM_PROMPT + '\n\nEs la primera vez que escribe este cliente. Respondé su consulta directamente y de forma natural preguntá su nombre y empresa en la misma respuesta. Sé breve y fluido.'
      : SYSTEM_PROMPT

    const historial = (conversaciones[jid] || [])
      .filter(m => m.de === 'cliente' || m.de === 'bot')
      .slice(-10)
      .map(m => ({ role: m.de === 'cliente' ? 'user' : 'assistant', content: m.texto }))

    const respuesta = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      system: promptFinal,
      messages: historial
    })

    const textoCompleto = respuesta.content[0].text
    const listoParaVenta = textoCompleto.includes('[ESTADO:LISTO_PARA_VENTA]')
    const mensajeLimpio = textoCompleto
      .replace(/\[ESTADO:CONSULTA\]/g, '')
      .replace(/\[ESTADO:LISTO_PARA_VENTA\]/g, '')
      .trim()

    botRespondiendo.add(jid)
    await whatsappSock.sendMessage(jid, { text: mensajeLimpio })
    botRespondiendo.delete(jid)

    if (esNuevo) esperandoNombre.add(jid)

    const msgBot = { de: 'bot', texto: mensajeLimpio, hora: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) }
    conversaciones[jid].push(msgBot)
    io.emit('nuevo_mensaje', { numero: jid, mensaje: msgBot })

    if (listoParaVenta) {
      io.emit('cliente_listo', jid)
      const numVentas = process.env.NUMERO_VENTAS
      if (numVentas) {
        const info = contactosInfo[jid] || {}
        const notif = [
          '🔔 *CLIENTE LISTO PARA COTIZAR*',
          info.nombre ? `Nombre: ${info.nombre}` : '',
          info.empresa ? `Empresa: ${info.empresa}` : '',
          `WhatsApp: wa.me/${telefono}`,
          `Mensaje: "${texto}"`
        ].filter(Boolean).join('\n')
        await whatsappSock.sendMessage(numVentas + '@s.whatsapp.net', { text: notif })
      }
    }

  } catch (error) {
    console.error('Error IA:', error.message)
    await whatsappSock.sendMessage(jid, {
      text: '¡Hola! Gracias por escribirnos a Both Company. Un asesor te contactará pronto.'
    })
  }
}

// ── Conectar WhatsApp ──
async function conectarWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState(supabase)
  const { version } = await fetchLatestBaileysVersion()

  whatsappSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Both Company Bot', 'Chrome', '1.0.0']
  })

  whatsappSock.ev.on('creds.update', saveCreds)

  // Poblar mapa LID → teléfono real cuando WhatsApp sincroniza contactos
  whatsappSock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.lid && contact.id && contact.id.endsWith('@s.whatsapp.net')) {
        const phone = contact.id.replace('@s.whatsapp.net', '')
        lidToPhone[contact.lid] = phone
        // Si ya tenemos info de este contacto con LID, actualizarla
        if (contactosInfo[contact.lid]) {
          contactosInfo[contact.lid].telefono = phone
          contactosInfo[contact.lid].display = phone
          io.emit('contacto_actualizado', { numero: contact.lid, info: contactosInfo[contact.lid] })
        }
      }
    }
  })

  whatsappSock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const url = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`
      ultimoQR = url
      io.emit('qr_disponible', url)
      console.log('\n==================================================')
      console.log('  ESCANEA EL QR CON TU WHATSAPP')
      console.log('  Abre este enlace en tu navegador:')
      console.log('  ' + url)
      console.log('==================================================\n')
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...')
        conectarWhatsApp()
      } else {
        console.log('Sesión cerrada. Borra ./session y reinicia para escanear el QR de nuevo.')
        botListo = false
        io.emit('bot_desconectado')
      }
    } else if (connection === 'open') {
      console.log('\n==============================')
      console.log('  BOT DE BOTH COMPANY ACTIVO')
      console.log('==============================\n')
      botListo = true
      ultimoQR = null
      io.emit('bot_conectado')
    }
  })

  whatsappSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return
    for (const message of messages) {
      if (!message.message) continue
      await procesarMensaje(message, type === 'notify')
    }
  })
}

// ── Iniciar ──
server.listen(PORT, () => {
  console.log(`Panel web en: http://localhost:${PORT}`)
})

conectarWhatsApp()
