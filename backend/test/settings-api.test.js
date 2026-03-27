import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestContext } from './helpers.js'

describe('Settings API', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('GET /api/settings returns default settings', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/settings' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(typeof body.defaultTtl, 'number')
    assert.ok(Array.isArray(body.allowedExtensions))
    assert.ok(Array.isArray(body.pathRules))
  })

  it('PUT /api/settings updates defaultTtl', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 300 }),
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().settings.defaultTtl, 300)

    // Verify via GET
    const get = await server.inject({ method: 'GET', url: '/api/settings' })
    assert.equal(get.json().defaultTtl, 300)

    // Restore
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 120 }),
    })
  })

  it('PUT /api/settings rejects negative defaultTtl', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: -5 }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects zero defaultTtl', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 0 }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects non-number defaultTtl', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 'abc' }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings updates allowedExtensions', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: ['jpg', 'png'] }),
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().settings.allowedExtensions, ['jpg', 'png'])

    // Restore
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: [] }),
    })
  })

  it('PUT /api/settings rejects non-array allowedExtensions', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: 'jpg' }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects allowedExtensions with empty strings', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: ['jpg', ''] }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects allowedExtensions with non-string items', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: [123] }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings updates pathRules', async () => {
    const rules = [
      { path: '/images/', ttl: 3600, cache: true },
      { path: '/api/', ttl: 0, cache: false },
    ]
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: rules }),
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().settings.pathRules, rules)

    // Restore
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: [] }),
    })
  })

  it('PUT /api/settings rejects non-array pathRules', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: 'not-array' }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects pathRule missing path', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: [{ ttl: 60, cache: true }] }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects pathRule with negative ttl', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: [{ path: '/x/', ttl: -1, cache: true }] }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings rejects pathRule with non-boolean cache', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: [{ path: '/x/', ttl: 60, cache: 'yes' }] }),
    })
    assert.equal(res.statusCode, 400)
  })

  it('PUT /api/settings with empty body is a no-op', async () => {
    const before = await server.inject({ method: 'GET', url: '/api/settings' })
    const res = await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.statusCode, 200)
    const after = await server.inject({ method: 'GET', url: '/api/settings' })
    assert.deepEqual(before.json(), after.json())
  })
})
