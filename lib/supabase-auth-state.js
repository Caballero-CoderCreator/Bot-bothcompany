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
