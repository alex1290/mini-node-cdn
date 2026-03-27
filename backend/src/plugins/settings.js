import fp from 'fastify-plugin'
import fs from 'node:fs/promises'

const DEFAULT_SETTINGS = {
  defaultTtl: 120,
  // empty = cache all extensions; e.g. ['jpg','png','css','js']
  allowedExtensions: [],
  // [{ path: '/images/', ttl: 3600, cache: true }]
  pathRules: [],
}

async function settingsPlugin(fastify) {
  const settingsFile = fastify.config.SETTINGS_FILE
  let settings = { ...DEFAULT_SETTINGS }

  // Load persisted settings on startup
  try {
    const raw = await fs.readFile(settingsFile, 'utf8')
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    fastify.log.info(`Settings loaded from ${settingsFile}`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fastify.log.warn({ err, settingsFile }, 'Failed to load settings — using defaults')
    }
  }

  fastify.decorate('settings', {
    get() {
      return { ...settings }
    },
    async update(patch) {
      const updated = { ...settings, ...patch }
      await fs.writeFile(settingsFile, JSON.stringify(updated, null, 2))
      settings = updated
      return { ...settings }
    },
  })
}

export default fp(settingsPlugin, { name: 'settings-plugin', dependencies: ['config-plugin'] })
