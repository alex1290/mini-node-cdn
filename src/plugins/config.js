import fp from 'fastify-plugin'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

async function configPlugin(fastify) {
  const PORT = parseInt(process.env.PORT || '3000', 10)
  const DEFAULT_TTL = parseInt(process.env.DEFAULT_TTL || '120', 10)

  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT} — must be an integer between 1 and 65535`)
  }
  if (!Number.isInteger(DEFAULT_TTL) || DEFAULT_TTL <= 0) {
    throw new Error(`Invalid DEFAULT_TTL: ${process.env.DEFAULT_TTL} — must be a positive integer`)
  }

  const config = {
    PORT,
    HOST: process.env.HOST || '0.0.0.0',
    ORIGIN_URL: process.env.ORIGIN_URL || 'http://localhost:8080',
    DEFAULT_TTL,
    CACHE_DIR: process.env.CACHE_DIR || path.join(projectRoot, 'cache'),
    SETTINGS_FILE: process.env.SETTINGS_FILE || path.join(projectRoot, 'settings.json'),
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    NODE_ENV: process.env.NODE_ENV || 'development',
  }
  fastify.log.info('Loaded config: %o',config)
  fastify.decorate('config', config)
}

export default fp(configPlugin, { name: 'config-plugin' })
