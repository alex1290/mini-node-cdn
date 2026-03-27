async function cacheRoutes(fastify) {
  // GET /api/cache — list all cached files with remaining TTL
  fastify.get('/', async () => {
    return fastify.cache.list()
  })

  // DELETE /api/cache — clear all cached files
  fastify.delete('/', async () => {
    const deletedCount = await fastify.cache.clearAll()
    return { message: 'Cache cleared', deletedCount }
  })

  // DELETE /api/cache/:key — clear a specific cached file
  fastify.delete('/:key', async (request, reply) => {
    const { key } = request.params
    const list = await fastify.cache.list()
    const exists = list.some(entry => entry.key === key)
    if (!exists) {
      reply.status(404)
      return { statusCode: 404, error: 'Not Found', message: `Cache key "${key}" not found` }
    }
    await fastify.cache.delete(key)
    return { message: `Cache key "${key}" deleted` }
  })
}

export default cacheRoutes
