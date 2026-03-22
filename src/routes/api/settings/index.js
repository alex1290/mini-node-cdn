async function settingsRoutes(fastify) {
  // GET /api/settings — return current settings
  fastify.get('/', async () => {
    return fastify.settings.get()
  })

  // PUT /api/settings — update settings
  fastify.put('/', async (request, reply) => {
    const { defaultTtl, allowedExtensions, pathRules } = request.body || {}

    const patch = {}

    if (defaultTtl !== undefined) {
      if (typeof defaultTtl !== 'number' || defaultTtl <= 0) {
        reply.status(400)
        return { statusCode: 400, error: 'Bad Request', message: 'defaultTtl must be a positive number' }
      }
      patch.defaultTtl = defaultTtl
    }

    if (allowedExtensions !== undefined) {
      if (!Array.isArray(allowedExtensions)) {
        reply.status(400)
        return { statusCode: 400, error: 'Bad Request', message: 'allowedExtensions must be an array' }
      }
      if (!allowedExtensions.every(e => typeof e === 'string' && e.length > 0)) {
        reply.status(400)
        return { statusCode: 400, error: 'Bad Request', message: 'allowedExtensions entries must be non-empty strings' }
      }
      patch.allowedExtensions = allowedExtensions
    }

    if (pathRules !== undefined) {
      if (!Array.isArray(pathRules)) {
        reply.status(400)
        return { statusCode: 400, error: 'Bad Request', message: 'pathRules must be an array' }
      }
      for (const rule of pathRules) {
        if (
          typeof rule !== 'object' || rule === null ||
          typeof rule.path !== 'string' || rule.path.length === 0 ||
          typeof rule.ttl !== 'number' || rule.ttl < 0 ||
          typeof rule.cache !== 'boolean'
        ) {
          reply.status(400)
          return {
            statusCode: 400,
            error: 'Bad Request',
            message: 'Each pathRule must have path (string), ttl (number >= 0), and cache (boolean)',
          }
        }
      }
      patch.pathRules = pathRules
    }

    const updated = await fastify.settings.update(patch)
    return { message: 'Settings updated', settings: updated }
  })
}

export default settingsRoutes
