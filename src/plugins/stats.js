import fp from 'fastify-plugin'

async function statsPlugin(fastify) {
  let hitCount = 0
  let missCount = 0

  fastify.decorate('stats', {
    recordHit() {
      hitCount++
    },
    recordMiss() {
      missCount++
    },
    async get() {
      return {
        total_files: await fastify.cache.totalFiles(),
        hit_count: hitCount,
        miss_count: missCount,
      }
    },
  })
}

export default fp(statsPlugin, {
  name: 'stats-plugin',
  dependencies: ['cache-manager-plugin'],
})
