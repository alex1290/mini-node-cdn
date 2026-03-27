import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTestContext } from './helpers.js'

describe('Cache API', () => {
  let server, cleanup

  before(async () => {
    ;({ server, cleanup } = await createTestContext())
  })

  after(async () => {
    await cleanup()
  })

  it('GET /api/cache returns an array', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/cache' })
    assert.equal(res.statusCode, 200)
    assert.ok(Array.isArray(res.json()))
  })

  it('DELETE /api/cache clears all files and total_files becomes 0', async () => {
    // Populate cache first
    await server.inject({ method: 'GET', url: '/hello.txt' })
    await server.inject({ method: 'GET', url: '/image.jpg' })

    const before = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.ok(before.json().total_files > 0, 'should have files before clear')

    const del = await server.inject({ method: 'DELETE', url: '/api/cache' })
    assert.equal(del.statusCode, 200)
    assert.equal(typeof del.json().deletedCount, 'number')

    const after = await server.inject({ method: 'GET', url: '/api/stats' })
    assert.equal(after.json().total_files, 0)
  })

  it('after clearing, next request is a MISS again', async () => {
    await server.inject({ method: 'DELETE', url: '/api/cache' })
    const res = await server.inject({ method: 'GET', url: '/hello.txt' })
    assert.equal(res.headers['x-cache'], 'MISS')
  })

  it('DELETE /api/cache/:key removes only that entry', async () => {
    await server.inject({ method: 'DELETE', url: '/api/cache' })
    await server.inject({ method: 'GET', url: '/hello.txt' })
    await server.inject({ method: 'GET', url: '/image.jpg' })

    const listRes = await server.inject({ method: 'GET', url: '/api/cache' })
    const list = listRes.json()
    assert.equal(list.length, 2)

    const firstKey = list[0].key
    const del = await server.inject({
      method: 'DELETE',
      url: `/api/cache/${encodeURIComponent(firstKey)}`,
    })
    assert.equal(del.statusCode, 200)

    const listAfter = await server.inject({ method: 'GET', url: '/api/cache' })
    assert.equal(listAfter.json().length, 1)
  })

  it('DELETE /api/cache/:key returns 404 for unknown key', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/cache/does-not-exist',
    })
    assert.equal(res.statusCode, 404)
  })

  it('GET /api/cache entries include remainingTtl, contentType, size', async () => {
    await server.inject({ method: 'DELETE', url: '/api/cache' })
    await server.inject({ method: 'GET', url: '/hello.txt' })

    const res = await server.inject({ method: 'GET', url: '/api/cache' })
    const [entry] = res.json()
    assert.ok(typeof entry.remainingTtl === 'number')
    assert.ok(typeof entry.contentType === 'string')
    assert.ok(typeof entry.size === 'number')
  })

  it('DELETE /api/cache/:key with path traversal attempt returns 404', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/cache/' + encodeURIComponent('../../etc/passwd'),
    })
    assert.equal(res.statusCode, 404)
  })

  it('DELETE /api/cache/:key with special characters returns 404', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/cache/' + encodeURIComponent('key<script>alert(1)</script>'),
    })
    assert.equal(res.statusCode, 404)
  })
})

describe('Cache — orphan file cleanup on init', () => {
  it('init() removes disk files that have no Redis metadata', async () => {
    // Create a context, write an orphan file, then restart the server
    const { server: s1, origin, cacheDir, cleanup: cleanup1 } = await createTestContext()

    // Place an orphan file directly on disk (no Redis entry)
    const orphanPath = path.join(cacheDir, 'orphan-file.txt')
    await fs.writeFile(orphanPath, 'I am orphan')

    // Verify it exists
    await assert.doesNotReject(() => fs.access(orphanPath))

    // Close the first server (keep origin alive for the second)
    await s1.close()

    // Boot a new server against the same cacheDir + Redis — init() should clean orphan
    process.env.CACHE_DIR = cacheDir
    const { buildServer } = await import('../src/server.js')
    const s2 = buildServer({ logger: false })
    await s2.ready()

    // Orphan file should be gone
    await assert.rejects(() => fs.access(orphanPath), { code: 'ENOENT' })

    await s2.close()
    await origin.close()
    await fs.rm(cacheDir, { recursive: true, force: true })
  })
})
