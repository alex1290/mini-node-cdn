async function dashboardRoutes(fastify) {
  fastify.get('/', async (request, reply) => {
    return reply.sendFile('index.html')
  })
}

export default dashboardRoutes
