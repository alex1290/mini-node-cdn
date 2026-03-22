import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestContext } from './helpers.js'

describe('Proxy — HIT / MISS / TTL / Settings', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('first request returns X-Cache: MISS', async () => {
    const res = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-cache'], 'MISS')
    assert.equal(res.body, 'Hello from origin!')
  })

  it('second request for same resource returns X-Cache: HIT', async () => {
    const res = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-cache'], 'HIT')
    assert.equal(res.body, 'Hello from origin!')
  })

  it('correct content-type is preserved from origin', async () => {
    const res = await server.inject({ method: 'GET', url: '/image.jpg' })
    assert.match(res.headers['content-type'], /image\/jpeg/)
  })

  it('origin 404 is forwarded to client (not cached)', async () => {
    const res = await server.inject({ method: 'GET', url: '/not-found' })
    assert.equal(res.statusCode, 404)
    // Next request should also be a MISS (errors are not cached)
    const res2 = await server.inject({ method: 'GET', url: '/not-found' })
    assert.equal(res2.headers['x-cache'], 'MISS')
  })

  it('file is served from cache after TTL=1s (manual expiry simulation)', async () => {
    // Set a very short TTL via settings
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 1 }),
    })

    // Cause a MISS to store with TTL=1
    await server.inject({ method: 'GET', url: '/script.js' })

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 1100))

    // Should be MISS again (expired)
    const res = await server.inject({ method: 'GET', url: '/script.js' })
    assert.equal(res.headers['x-cache'], 'MISS')

    // Restore default TTL
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultTtl: 120 }),
    })
  })

  it('path not matching allowedExtensions is not cached', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: ['jpg', 'png'] }),
    })

    // .txt is not in allowedExtensions — should never be HIT
    const res1 = await server.inject({ method: 'GET', url: '/hello.txt' })
    // Delete the old cache for hello.txt so we get a clean run
    const cacheList = await server.inject({ method: 'GET', url: '/api/cache' })
    const entries = JSON.parse(cacheList.body)
    const hello = entries.find(e => e.originalPath === '/hello.txt')
    if (hello) {
      await server.inject({ method: 'DELETE', url: `/api/cache/${hello.key}` })
    }

    const missRes = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(missRes.headers['x-cache'], 'MISS')

    const missRes2 = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(missRes2.headers['x-cache'], 'MISS', '.txt should never be cached')

    // Restore
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedExtensions: [] }),
    })
  })
})

describe('Proxy — pathRules, errors, and edge cases', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('pathRules are matched by array order (first match wins)', async () => {
    // Set up two rules: a broad /sub/ and specific /sub/dir/
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pathRules: [
          { path: '/sub/', ttl: 10, cache: false },   // broad first
          { path: '/sub/dir/', ttl: 3600, cache: true }, // specific second
        ],
      }),
    })

    // /sub/dir/file.txt matches /sub/ first → cache: false → always MISS
    const res1 = await server.inject({ method: 'GET', url: '/sub/dir/file.txt' })
    assert.equal(res1.statusCode, 200)
    assert.equal(res1.headers['x-cache'], 'MISS')

    const res2 = await server.inject({ method: 'GET', url: '/sub/dir/file.txt' })
    assert.equal(res2.headers['x-cache'], 'MISS', 'first rule matched, cache=false')

    // Restore
    await server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pathRules: [] }),
    })
  })

  it('query string is ignored for cache key', async () => {
    await server.inject({ method: 'DELETE', url: '/api/cache' })

    const res1 = await server.inject({ method: 'GET', url: '/hello.txt?v=1' })
    assert.equal(res1.headers['x-cache'], 'MISS')

    // Same path different query → should be HIT
    const res2 = await server.inject({ method: 'GET', url: '/hello.txt?v=2' })
    assert.equal(res2.headers['x-cache'], 'HIT')
  })

  it('origin 5xx is forwarded and not cached', async () => {
    const res = await server.inject({ method: 'GET', url: '/server-error' })
    assert.equal(res.statusCode, 500)

    // Second request should still be MISS (error not cached)
    const res2 = await server.inject({ method: 'GET', url: '/server-error' })
    assert.equal(res2.headers['x-cache'], 'MISS')
  })

  it('nested path /sub/dir/file.txt is proxied correctly', async () => {
    const res = await server.inject({ method: 'GET', url: '/sub/dir/file.txt' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'nested file')
  })

  it('path traversal attempt /../etc/passwd is normalized', async () => {
    // Should NOT escape the cache directory — just returns a 404/502 from origin
    const res = await server.inject({ method: 'GET', url: '/../../../etc/passwd' })
    // Origin doesn't serve this, so we expect a non-200 status
    assert.ok(res.statusCode >= 400)
  })

  it('GET /favicon.ico returns 204', async () => {
    const res = await server.inject({ method: 'GET', url: '/favicon.ico' })
    assert.equal(res.statusCode, 204)
  })
})
