// Wildcard CDN proxy — catches every GET request not matched by a more specific route
// Fastify's find-my-way router guarantees static routes (/api/*, /dashboard)
// always take priority over this wildcard.

async function proxyRoutes(fastify) {
  // Browsers automatically request /favicon.ico on every page load.
  // Return 204 immediately to prevent it from being proxied and counted as a MISS.
  fastify.get('/favicon.ico', async (_request, reply) => {
    return reply.code(204).send()
  })

  fastify.get('/*', async (request, reply) => {
    // Use pathname only as the cache key — ignore query strings
    const urlPath = new URL(request.url, 'http://localhost').pathname

    const settings = fastify.settings.get()
    const shouldCache = isCacheable(urlPath, settings)
    const effectiveTtl = getEffectiveTtl(urlPath, settings)

    if (shouldCache) {
      const cached = await fastify.cache.get(urlPath)
      if (cached.hit) {
        fastify.stats.recordHit()
        reply.header('X-Cache', 'HIT')
        reply.type(cached.contentType)
        const { createReadStream } = await import('node:fs')
        return reply.send(createReadStream(cached.filePath))
      }
    }

    // Cache MISS — fetch from origin
    fastify.stats.recordMiss()
    reply.header('X-Cache', 'MISS')

    // Build the full origin URL (include original query string)
    const originUrl = new URL(request.url, fastify.config.ORIGIN_URL).href

    try {
      let result
      if (shouldCache) {
        // fetchAndStore handles in-flight deduplication + atomic write
        result = await fastify.cache.fetchAndStore(urlPath, effectiveTtl, () =>
          fetchFromOrigin(originUrl)
        )
      } else {
        result = await fetchFromOrigin(originUrl)
      }

      reply.type(result.contentType)
      return reply.send(result.buffer)
    } catch (err) {
      const status = err.statusCode || 502
      reply.status(status)
      return reply.send({
        statusCode: status,
        error: status === 502 ? 'Bad Gateway' : err.message,
        message: `Failed to fetch from origin: ${originUrl}`,
      })
    }
  })
}

// Determine effective TTL for a path (path rules override default)
function getEffectiveTtl(urlPath, settings) {
  const rule = settings.pathRules.find(r => urlPath.startsWith(r.path))
  return rule?.ttl ?? settings.defaultTtl
}

// Check whether a given path should be cached
function isCacheable(urlPath, settings) {
  // Path-level rules take highest priority
  const rule = settings.pathRules.find(r => urlPath.startsWith(r.path))
  if (rule) return rule.cache !== false

  // If no extension allowlist, cache everything
  if (settings.allowedExtensions.length === 0) return true

  const ext = urlPath.split('.').pop()?.toLowerCase() || ''
  return settings.allowedExtensions.includes(ext)
}

const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024 // 50 MB

async function fetchFromOrigin(originUrl) {
  let response
  try {
    response = await fetch(originUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const error = new Error(err.message)
    error.statusCode = 502
    throw error
  }

  if (!response.ok) {
    const error = new Error(`Origin server responded with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const contentLength = Number(response.headers.get('content-length'))
  if (contentLength > MAX_RESPONSE_SIZE) {
    const error = new Error(`Response too large: ${contentLength} bytes`)
    error.statusCode = 502
    throw error
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  if (buffer.length > MAX_RESPONSE_SIZE) {
    const error = new Error(`Response too large: ${buffer.length} bytes`)
    error.statusCode = 502
    throw error
  }

  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'

  return { buffer, contentType }
}

export default proxyRoutes
