import { buildServer } from './server.js'

const server = buildServer()

try {
  await server.listen({
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
  })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}

const shutdown = async () => {
  server.log.info('Shutting down gracefully...')
  try {
    await server.close()
    process.exit(0)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
