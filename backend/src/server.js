import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import autoload from '@fastify/autoload'
import cors from '@fastify/cors'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export function buildServer(options = {}) {
  const isTest = process.env.NODE_ENV === 'test'

  const server = Fastify({
    logger: options.logger ?? (isTest ? false : { level: 'info' }),
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    trustProxy: true,
    routerOptions: {
      ignoreTrailingSlash: true,
    },
  })

  // CORS
  server.register(cors, { origin: true })

  // Auto-load shared plugins (config, cache-manager, settings, stats, static)
  // Dependencies declared in each plugin ensure correct load ordering
  server.register(autoload, {
    dir: path.join(__dirname, 'plugins'),
  })

  // Auto-load routes — folder names become URL prefixes
  // routes/index.js         → /*  (proxy wildcard, no prefix)
  // routes/api/stats/       → /api/stats
  // routes/api/cache/       → /api/cache
  // routes/api/settings/    → /api/settings
  // routes/dashboard/       → /dashboard
  server.register(autoload, {
    dir: path.join(__dirname, 'routes'),
  })

  return server
}
