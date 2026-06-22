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

// ── Modelos ──
// Haiku para saludos/FAQ/clasificación (rápido y barato).
// Sonnet solo para cotizaciones: sumar bordados/tamaños/cantidades con la tabla de precios.
const MODELO_RAPIDO = 'claude-haiku-4-5-20251001'
const MODELO_COTIZA = 'claude-sonnet-4-6'

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
const colasPorJid = {}  // cola de procesamiento por JID para evitar respuestas paralelas
let reconectando = false

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
- Dirigite SIEMPRE al cliente de USTED (trato formal y profesional). Nunca uses "vos" ni "tú".
- Tono de proveedor serio para empresas: profesional y cálido, sin jerga ni exceso de confianza.
- Respondé en español, de forma directa y sin frases de relleno. Máximo 3-4 líneas por respuesta.
- Si el cliente da suficiente info, prepará una cotización estimada usando la tabla de precios.
- Si falta info para cotizar, solicitá lo necesario de forma natural y cortés.
- Si no sabés algo, indicá que un asesor lo confirmará.

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

// ── Marca actividad del cliente para el follow-up ──
// Actualiza ultimo_contacto_at (y opcionalmente el estado). NO resetea followup_at:
// cada cliente recibe como máximo un follow-up histórico.
async function marcarContacto(clienteId, estado) {
  if (!clienteId) return
  const patch = { ultimo_contacto_at: new Date().toISOString() }
  if (estado) patch.estado_conv = estado
  try {
    await supabase.from('clientes').update(patch).eq('id', clienteId)
  } catch (e) {
    console.error('Error marcarContacto:', e.message)
  }
}

// ── Extrae nombre/empresa de un mensaje ──
async function extraerNombreEmpresa(texto) {
  try {
    const res = await anthropic.messages.create({
      model: MODELO_RAPIDO,
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

// ── Clasifica si el cliente está pidiendo/armando una cotización (→ Sonnet) ──
async function necesitaCotizacion(contexto, textoActual) {
  try {
    const res = await anthropic.messages.create({
      model: MODELO_RAPIDO,
      max_tokens: 5,
      system: `Clasificás el último mensaje de un cliente de una empresa de bordados y uniformes. Respondé SOLO con una palabra, sin nada más:
COTIZA = pide un precio/cotización o está dando los datos para una (cantidad, prenda, tipo o tamaño de bordado, "cuánto sale", "precio por X unidades", confirma cantidades o medidas).
GENERAL = saludos, preguntas informativas sin números, dudas sobre el servicio, o charla.`,
      messages: [{ role: 'user', content: `Conversación reciente:\n${contexto}\n\nÚltimo mensaje a clasificar: "${textoActual}"` }]
    })
    return res.content[0].text.toUpperCase().includes('COTIZA')
  } catch (e) {
    return false  // ante error, usar el modelo rápido por defecto
  }
}

// ── Socket.io ──
io.on('connection', (socket) => {
  socket.emit('conversaciones_iniciales', { conversaciones, tomadoPorHumano, contactosInfo })
  if (botListo) socket.emit('bot_conectado')
  else if (ultimoQR) socket.emit('qr_disponible', ultimoQR)

  socket.on('tomar_control', (fromId) => {
    tomadoPorHumano[fromId] = true
    marcarContacto(contactosInfo[fromId]?.clienteId, 'atendido')  // lo atiende un humano
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

  const textoRaw = message.message?.conversation
    || message.message?.extendedTextMessage?.text
    || message.message?.imageMessage?.caption
    || ''

  const esImagen = !!(message.message?.imageMessage || message.message?.stickerMessage || message.message?.documentMessage)
  const texto = textoRaw || (esImagen ? '[El cliente envió una imagen — probablemente su logo o diseño. Indicale que la recibiste y que un asesor la revisará]' : '')

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
      marcarContacto(contactosInfo[jid]?.clienteId, 'atendido')  // el dueño respondió desde su teléfono
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

  // Mensajes históricos (append al reconectar): solo mostrar en panel, nunca responder
  if (!enTiempoReal) return

  // Registrar actividad del cliente (base del follow-up automático)
  marcarContacto(clienteId)

  if (tomadoPorHumano[jid]) {
    io.emit('atencion_requerida', jid)
    return
  }

  // Si estamos esperando nombre/empresa
  if (esperandoNombre.has(jid)) {
    esperandoNombre.delete(jid)
    try {
      const extraido = await extraerNombreEmpresa(texto)
      if (extraido && (extraido.nombre || extraido.empresa)) {
        const nombre = extraido.nombre || pushName
        const emp = extraido.empresa || ''
        const telefonoGuardar = telefonoReal || jid.replace('@lid', '').replace('@s.whatsapp.net', '')
        await guardarCliente(telefonoGuardar, nombre, emp)
        contactosInfo[jid] = {
          ...contactosInfo[jid],
          telefono: telefonoReal,
          display: telefonoReal || nombre,
          nombre,
          empresa: emp
        }
        io.emit('contacto_actualizado', { numero: jid, info: contactosInfo[jid] })
      }
    } catch (e) {
      console.error('Error extrayendo nombre/empresa:', e.message)
    }
  }

  try {
    const promptFinal = esNuevo
      ? SYSTEM_PROMPT + '\n\nEs la primera vez que escribe este cliente. Respondé su consulta directamente y, de forma natural y cortés, pregúntele su nombre y el de su empresa en la misma respuesta. Sea breve y profesional, tratándolo siempre de usted.'
      : SYSTEM_PROMPT

    const historial = (conversaciones[jid] || [])
      .filter(m => m.de === 'cliente' || m.de === 'bot')
      .slice(-14)
      .map(m => ({ role: m.de === 'cliente' ? 'user' : 'assistant', content: m.texto }))

    await whatsappSock.sendPresenceUpdate('composing', jid)

    // Enrutado: si el cliente pide/arma una cotización → Sonnet (más preciso con números); si no → Haiku
    const contextoClasif = historial.slice(-4)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n')
    const cotizando = await necesitaCotizacion(contextoClasif, texto)
    const modeloRespuesta = cotizando ? MODELO_COTIZA : MODELO_RAPIDO
    if (cotizando) console.log('→ Intencion de cotizar detectada: respondiendo con Sonnet')

    const respuesta = await anthropic.messages.create({
      model: modeloRespuesta,
      max_tokens: 600,
      system: promptFinal,
      messages: historial
    })

    const textoCompleto = respuesta.content[0].text
    const listoParaVenta = textoCompleto.includes('[ESTADO:LISTO_PARA_VENTA]')
    const mensajeLimpio = textoCompleto
      .replace(/\[ESTADO:CONSULTA\]/g, '')
      .replace(/\[ESTADO:LISTO_PARA_VENTA\]/g, '')
      .trim()

    await whatsappSock.sendPresenceUpdate('paused', jid)
    botRespondiendo.add(jid)
    await whatsappSock.sendMessage(jid, { text: mensajeLimpio })
    botRespondiendo.delete(jid)

    if (esNuevo) esperandoNombre.add(jid)

    const msgBot = { de: 'bot', texto: mensajeLimpio, hora: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) }
    conversaciones[jid].push(msgBot)
    io.emit('nuevo_mensaje', { numero: jid, mensaje: msgBot })

    if (listoParaVenta) {
      io.emit('cliente_listo', jid)
      marcarContacto(clienteId, 'listo')  // ya pasó a ventas: no recibe follow-up de consulta
      const numVentas = process.env.NUMERO_VENTAS
      if (numVentas) {
        const info = contactosInfo[jid] || {}
        const telefonoNotif = telefonoReal || info.telefono || jid.replace('@lid', '').replace('@s.whatsapp.net', '')
        const notif = [
          '🔔 *CLIENTE LISTO PARA COTIZAR*',
          info.nombre ? `Nombre: ${info.nombre}` : '',
          info.empresa ? `Empresa: ${info.empresa}` : '',
          telefonoNotif ? `WhatsApp: wa.me/${telefonoNotif}` : '',
          `Mensaje: "${texto}"`
        ].filter(Boolean).join('\n')
        await whatsappSock.sendMessage(numVentas + '@s.whatsapp.net', { text: notif })
      }
    }

  } catch (error) {
    console.error('Error IA:', error.message)
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
      if (code !== DisconnectReason.loggedOut && !reconectando) {
        reconectando = true
        console.log('Reconectando en 5 segundos...')
        setTimeout(() => { reconectando = false; conectarWhatsApp() }, 5000)
      } else if (code === DisconnectReason.loggedOut) {
        console.log('Sesión cerrada. Reiniciá el servidor para escanear el QR de nuevo.')
        botListo = false
        io.emit('bot_desconectado')
      }
    } else if (connection === 'open') {
      reconectando = false
      console.log('\n==============================')
      console.log('  BOT DE BOTH COMPANY ACTIVO')
      console.log('==============================\n')
      botListo = true
      ultimoQR = null
      io.emit('bot_conectado')
    }
  })

  whatsappSock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return
    for (const message of messages) {
      if (!message.message) continue
      const jid = message.key.remoteJid
      if (!jid) continue
      const esNotify = type === 'notify'
      const anterior = colasPorJid[jid] || Promise.resolve()
      colasPorJid[jid] = anterior
        .then(() => procesarMensaje(message, esNotify))
        .catch(e => console.error('Error procesando mensaje:', e.message))
    }
  })
}

// ── Follow-up automático ──
// Recontacta una vez a clientes de WhatsApp que consultaron y se enfriaron (>24h sin
// avanzar), nunca atendidos por humano ni pasados a venta. Lee de Supabase (no memoria),
// así que sobrevive reinicios de Railway. Solo envía en horario diurno de El Salvador.
const FOLLOWUP_HORAS = 24          // horas de inactividad antes de recontactar
const FOLLOWUP_HORA_INICIO = 8     // no enviar antes de las 8am (hora SV)
const FOLLOWUP_HORA_FIN = 20       // ni después de las 8pm
const FOLLOWUP_MAX_POR_CICLO = 15  // tope de envíos por chequeo (anti-burst)

const FOLLOWUP_MENSAJE = `Buen día{nombre}. Le saludamos de Both Company. Damos seguimiento a su consulta sobre bordados y uniformes corporativos. Con gusto preparamos una cotización a la medida de su empresa, sin compromiso. Quedamos atentos a sus comentarios.`

// El Salvador es UTC-6 todo el año (sin horario de verano)
function horaSV() {
  return (new Date().getUTCHours() - 6 + 24) % 24
}

async function revisarFollowups() {
  if (!botListo || !whatsappSock) return
  const h = horaSV()
  if (h < FOLLOWUP_HORA_INICIO || h >= FOLLOWUP_HORA_FIN) return

  const corte = new Date(Date.now() - FOLLOWUP_HORAS * 3600 * 1000).toISOString()
  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, nombre, telefono')
      .eq('fuente', 'whatsapp')
      .eq('estado_conv', 'consulta')
      .is('followup_at', null)
      .not('ultimo_contacto_at', 'is', null)
      .lt('ultimo_contacto_at', corte)
      .limit(FOLLOWUP_MAX_POR_CICLO)

    if (error) { console.error('Follow-up query:', error.message); return }
    if (!data || data.length === 0) return

    for (const c of data) {
      // solo teléfonos reales (no LIDs ni identificadores raros)
      if (!c.telefono || !/^[0-9]{8,15}$/.test(c.telefono)) continue
      const jid = c.telefono + '@s.whatsapp.net'
      const nombre = (c.nombre && !/^[0-9]+$/.test(c.nombre)) ? ' ' + c.nombre.split(' ')[0] : ''
      const msg = FOLLOWUP_MENSAJE.replace('{nombre}', nombre)
      try {
        botRespondiendo.add(jid)
        await whatsappSock.sendMessage(jid, { text: msg })
        botRespondiendo.delete(jid)
        await supabase.from('clientes').update({ followup_at: new Date().toISOString() }).eq('id', c.id)

        const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
        const m = { de: 'bot', texto: msg, hora }
        if (!conversaciones[jid]) conversaciones[jid] = []
        conversaciones[jid].push(m)
        io.emit('nuevo_mensaje', { numero: jid, mensaje: m })
        console.log(`Follow-up enviado a ${c.telefono}`)

        await new Promise(r => setTimeout(r, 5000))  // espaciar envíos
      } catch (e) {
        console.error(`Error follow-up a ${c.telefono}:`, e.message)
      }
    }
  } catch (e) {
    console.error('revisarFollowups:', e.message)
  }
}

// ── Iniciar ──
server.listen(PORT, () => {
  console.log(`Panel web en: http://localhost:${PORT}`)
})

conectarWhatsApp()
setInterval(revisarFollowups, 30 * 60 * 1000)  // cada 30 min
