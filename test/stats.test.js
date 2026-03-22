import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestContext } from './helpers.js'

describe('Stats API', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('GET /api/stats returns correct initial values', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(typeof body.total_files, 'number')
    assert.equal(typeof body.hit_count, 'number')
    assert.equal(typeof body.miss_count, 'number')
  })

  it('miss_count increments on MISS', async () => {
    const before = res => res.json().miss_count

    const s1 = await server.inject({ method: 'GET', url: '/api/stats' })
    const initialMiss = before(s1)

    await server.inject({ method: 'GET', url: '/hello.txt' }) // MISS

    const s2 = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(s2.json().miss_count, initialMiss + 1)
  })

  it('hit_count increments on HIT', async () => {
    // Ensure file is already cached
    await server.inject({ method: 'GET', url: '/image.jpg' })

    const s1 = await server.inject({ method: 'GET', url: '/api/stats' })
    const initialHit = s1.json().hit_count

    await server.inject({ method: 'GET', url: '/image.jpg' }) // HIT

    const s2 = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(s2.json().hit_count, initialHit + 1)
  })

  it('total_files reflects cache count', async () => {
    // Clear first for a clean baseline
    await server.inject({ method: 'DELETE', url: '/api/cache' })

    const s1 = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(s1.json().total_files, 0)

    await server.inject({ method: 'GET', url: '/hello.txt' })

    const s2 = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(s2.json().total_files, 1)
  })
})
