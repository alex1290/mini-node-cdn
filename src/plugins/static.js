import fp from 'fastify-plugin'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

async function staticPlugin(fastify) {
  const isDev = fastify.config?.NODE_ENV !== 'production'
  fastify.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/public/',
    decorateReply: true,
    // Cache static assets in browser for 1 hour in production, no-cache in dev
    maxAge: isDev ? 0 : 3600 * 1000,
  })
}

// fastify-plugin breaks encapsulation so reply.sendFile is available globally
export default fp(staticPlugin, { name: 'static-plugin' })
