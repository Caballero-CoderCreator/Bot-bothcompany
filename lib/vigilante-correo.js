// ── Vigilante de correo ──
// Revisa juan@ (Recibidos + Spam) y avisa por WhatsApp cuando un prospecto de la campaña
// de email responde. No depende de la PC: corre dentro del bot en Railway.
// Deduplica con la etiqueta de Gmail "Avisado-WA" (sobrevive reinicios). Solo lee Supabase:
// el estado del prospecto lo sigue moviendo campana-email.py en su corrida diaria.
const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')

const ETIQUETA = 'Avisado-WA'
const VENTANA = 'newer_than:4d'  // solo correos recientes; lo viejo ya se atendió a mano
const AUTOMATICOS = ['mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'nopreply', 'dmarc', 'notifications@']
const DOMINIOS_GENERICOS = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com', 'hotmail.es', 'yahoo.es', 'outlook.es', 'msn.com'])
const MARCA_WARMUP = 'month-uncle'  // token del warm-up de Smartlead, no es una persona

function limpiarAsunto(s) {
  return String(s || '').replace(/^\s*((re|rv|res|fw|fwd|reenviar)\s*:\s*)+/i, '').trim().toLowerCase()
}

// Texto que escribió la persona, sin el correo citado debajo
function textoPropio(texto) {
  const corte = String(texto || '').split(/\n\s*(El [\s\S]{5,160}?escribi|On [\s\S]{5,160}?wrote|De:|From:|-{5,}\s*(Mensaje reenviado|Forwarded message|Original)|_{8,})/i)[0]
  return corte.split('\n').filter(l => !l.trim().startsWith('>')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function fechaSV(d) {
  return new Date(d || Date.now()).toLocaleString('es-SV', {
    timeZone: 'America/El_Salvador', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  })
}

function crearVigilante({ supabase, enviarAviso, usuario, password }) {
  let enCurso = false

  async function cargarProspectos() {
    const { data, error } = await supabase
      .from('prospectos').select('id, empresa, email, asunto_email, estado').not('email', 'is', null)
    if (error) throw new Error('Supabase prospectos: ' + error.message)
    return data || []
  }

  // Devuelve el prospecto al que pertenece el correo, o null si no es de la campaña
  function identificar(correo, prospectos) {
    const refs = [correo.inReplyTo, ...[].concat(correo.references || [])].join(' ')
    const m = refs.match(/bc1-(\d+)-t\d+@bothcompanysv\.com/)
    if (m) {
      const p = prospectos.find(x => String(x.id) === m[1])
      if (p) return p
    }
    const remitente = (correo.from?.value?.[0]?.address || '').toLowerCase()
    const dominio = remitente.split('@')[1] || ''
    let p = prospectos.find(x => x.email.trim().toLowerCase() === remitente)
    if (!p && dominio && !DOMINIOS_GENERICOS.has(dominio)) {
      p = prospectos.find(x => x.email.trim().toLowerCase().endsWith('@' + dominio))
    }
    // Contestó desde otra dirección pero en el mismo hilo (ej. SECOMSAL desde un hotmail)
    if (!p) {
      const asunto = limpiarAsunto(correo.subject)
      if (asunto.length >= 10) p = prospectos.find(x => x.asunto_email && limpiarAsunto(x.asunto_email) === asunto)
    }
    return p || null
  }

  function armarAviso(correo, p) {
    const de = correo.from?.value?.[0] || {}
    let texto = textoPropio(correo.text)
    if (texto.length > 600) texto = texto.slice(0, 600) + '…'
    const msgId = String(correo.messageId || '').replace(/[<>]/g, '')
    return [
      '📧 *PROSPECTO RESPONDIÓ POR CORREO*',
      `Empresa: ${p.empresa}`,
      `De: ${de.name ? de.name + ' ' : ''}<${de.address}>`,
      `Asunto: ${correo.subject || '(sin asunto)'}`,
      `Recibido: ${fechaSV(correo.date)}`,
      `Mensaje: "${texto || '(sin texto, revisar adjuntos)'}"`,
      msgId ? `Abrir: https://mail.google.com/mail/u/${usuario}/#search/rfc822msgid%3A${encodeURIComponent(msgId)}` : ''
    ].filter(Boolean).join('\n')
  }

  async function revisar({ soloProbar = false } = {}) {
    if (enCurso) return { omitido: 'ya hay una revisión en curso' }
    enCurso = true
    const resultado = { avisados: [], ignorados: 0 }
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: usuario, pass: password }, logger: false })
    try {
      const prospectos = await cargarProspectos()
      await client.connect()
      const carpetas = await client.list()
      const spam = carpetas.find(c => c.specialUse === '\\Junk')?.path
      for (const carpeta of ['INBOX', spam].filter(Boolean)) {
        const lock = await client.getMailboxLock(carpeta)
        try {
          const uids = await client.search({ gmraw: `${VENTANA} -label:${ETIQUETA} -from:me` }, { uid: true })
          for (const uid of uids || []) {
            const msg = await client.fetchOne(uid, { source: true }, { uid: true })
            const correo = await simpleParser(msg.source)
            const remitente = (correo.from?.value?.[0]?.address || '').toLowerCase()
            const auto = correo.headers.get('auto-submitted')
            if (AUTOMATICOS.some(a => remitente.includes(a)) || (auto && auto !== 'no') || String(correo.text || '').includes(MARCA_WARMUP)) {
              resultado.ignorados++
              continue
            }
            const p = identificar(correo, prospectos)
            if (!p) { resultado.ignorados++; continue }
            const aviso = armarAviso(correo, p)
            if (!soloProbar) {
              await enviarAviso(aviso)  // si falla, no se etiqueta y se reintenta en la próxima vuelta
              await client.messageFlagsAdd(uid, [ETIQUETA], { uid: true, useLabels: true })
              console.log(`Vigilante correo → aviso WhatsApp: ${p.empresa} <${remitente}>`)
            }
            resultado.avisados.push({ carpeta, empresa: p.empresa, de: remitente, asunto: correo.subject, aviso: soloProbar ? aviso : undefined })
          }
        } finally {
          lock.release()
        }
      }
    } finally {
      enCurso = false
      try { await client.logout() } catch (_) {}
    }
    return resultado
  }

  return { revisar }
}

module.exports = { crearVigilante }
