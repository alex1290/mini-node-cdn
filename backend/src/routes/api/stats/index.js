async function statsRoutes(fastify) {
  fastify.get('/', async () => {
    return fastify.stats.get()
  })
}

export default statsRoutes
