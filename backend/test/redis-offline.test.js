import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createNoRedisTestContext } from './helpers.js'

describe('Redis offline — Stats & Cache API', () => {
  let server, cacheDir, cleanup

  before(async () => {
    ;({ server, cacheDir, cleanup } = await createNoRedisTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('GET /api/stats returns redis_connected: false', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.redis_connected, false)
  })

  it('GET /api/cache returns empty array', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/cache' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [])
  })

  it('DELETE /api/cache returns deletedCount 0', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/api/cache' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().deletedCount, 0)
  })

  it('DELETE /api/cache/:key returns 404', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/cache/nonexistent',
    })
    assert.equal(res.statusCode, 404)
  })
})

describe('Redis offline — Proxy', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createNoRedisTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('first request returns 200 with X-Cache: MISS', async () => {
    const res = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-cache'], 'MISS')
    assert.equal(res.body, 'Hello from origin!')
  })

  it('second request is still MISS (cannot cache without Redis)', async () => {
    const res = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-cache'], 'MISS')
  })

  it('origin 404 is forwarded normally', async () => {
    const res = await server.inject({ method: 'GET', url: '/not-found' })
    assert.equal(res.statusCode, 404)
  })

  it('origin 500 is forwarded normally', async () => {
    const res = await server.inject({ method: 'GET', url: '/server-error' })
    assert.equal(res.statusCode, 500)
  })
})

describe('Redis offline — Disk fallback', () => {
  let server, cacheDir, cleanup

  before(async () => {
    ;({ server, cacheDir, cleanup } = await createNoRedisTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('totalFiles returns 0 for empty cache dir', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(res.json().total_files, 0)
  })

  it('totalFiles counts manually placed disk files via readdir', async () => {
    // Place two fake files in cache dir
    await fs.writeFile(path.join(cacheDir, 'fakefile1'), 'data1')
    await fs.writeFile(path.join(cacheDir, 'fakefile2'), 'data2')

    const res = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(res.json().total_files, 2)
  })

  it('totalFiles ignores .tmp- files', async () => {
    await fs.writeFile(path.join(cacheDir, '.tmp-partial'), 'partial')

    const res = await server.inject({ method: 'GET', url: '/api/stats' })
    // Should still be 2 (fakefile1, fakefile2) — .tmp-partial excluded
    assert.equal(res.json().total_files, 2)
  })

  it('DELETE /api/cache clears manually placed disk files', async () => {
    const del = await server.inject({ method: 'DELETE', url: '/api/cache' })
    assert.equal(del.json().deletedCount, 2) // fakefile1 + fakefile2 (not .tmp-)

    const res = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(res.json().total_files, 0)
  })
})

describe('Redis offline — Settings API', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createNoRedisTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('GET /api/settings works without Redis', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/settings' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(typeof body.defaultTtl, 'number')
    assert.ok(Array.isArray(body.allowedExtensions))
    assert.ok(Array.isArray(body.pathRules))
  })

  it('PUT /api/settings works without Redis', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 300 }),
    })
    assert.equal(res.statusCode, 200)

    const get = await server.inject({ method: 'GET', url: '/api/settings' })
    assert.equal(get.json().defaultTtl, 300)
  })
})
