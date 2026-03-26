import { buildServer } from '../src/server.js'
import Fastify from 'fastify'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import Redis from 'ioredis'

// Use Redis DB 15 for test isolation
const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/15'

/**
 * Create a CDN server with an isolated temp cache directory and
 * a mock origin server.
 *
 * @returns {{ server, origin, cacheDir, cleanup }}
 */
export async function createTestContext() {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdn-test-'))

  // Flush the test Redis DB before each test context
  const testRedis = new Redis(TEST_REDIS_URL)
  await testRedis.flushdb()
  await testRedis.quit()

  // --- Mock Origin Server ---
  const origin = Fastify({ logger: false })

  origin.get('/hello.txt', async (req, reply) => {
    return reply.type('text/plain').send('Hello from origin!')
  })

  origin.get('/image.jpg', async (req, reply) => {
    // 10-byte fake image buffer
    return reply.type('image/jpeg').send(Buffer.alloc(10, 0xff))
  })

  origin.get('/script.js', async (req, reply) => {
    return reply.type('application/javascript').send('console.log("hi")')
  })

  origin.get('/not-found', async (req, reply) => {
    reply.status(404)
    return { error: 'not found' }
  })

  origin.get('/server-error', async (req, reply) => {
    reply.status(500)
    return { error: 'internal server error' }
  })

  origin.get('/slow', async (req, reply) => {
    // Simulates a slow response (longer than test timeout expectations)
    await new Promise(r => setTimeout(r, 60_000))
    return reply.type('text/plain').send('slow')
  })

  origin.get('/sub/dir/file.txt', async (req, reply) => {
    return reply.type('text/plain').send('nested file')
  })

  // Endpoints for cache key collision regression test
  origin.get('/assets/js/app.js', async (req, reply) => {
    return reply.type('application/javascript').send('// from /assets/js/app.js')
  })

  origin.get('/assets/js--app.js', async (req, reply) => {
    return reply.type('application/javascript').send('// from /assets/js--app.js')
  })

  origin.get('/encoded%20file.txt', async (req, reply) => {
    return reply.type('text/plain').send('encoded')
  })

  await origin.listen({ port: 0, host: '127.0.0.1' })
  const originPort = origin.server.address().port
  const originUrl = `http://127.0.0.1:${originPort}`

  // --- CDN Server ---
  process.env.ORIGIN_URL = originUrl
  process.env.CACHE_DIR  = cacheDir
  process.env.REDIS_URL  = TEST_REDIS_URL
  process.env.NODE_ENV   = 'test'

  const server = buildServer({ logger: false })
  await server.ready()

  async function cleanup() {
    await server.close()
    await origin.close()
    await fs.rm(cacheDir, { recursive: true, force: true })
  }

  return { server, origin, cacheDir, cleanup }
}
