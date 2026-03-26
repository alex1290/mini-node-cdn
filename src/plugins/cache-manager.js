import fp from 'fastify-plugin'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import Redis from 'ioredis'

const KEY_PREFIX = 'cache:meta:'

// Hash a URL path into a fixed-length, collision-free cache key
// e.g. /images/photo.jpg → 32-char MD5 hex digest
function pathToKey(urlPath) {
  // Normalize to collapse ../ sequences, then strip any remaining leading ../
  const normalized = path.posix.normalize(urlPath).replace(/^(\.\.\/)+/, '')
  const clean = normalized.replace(/^\/+/, '')
  return createHash('md5').update(clean).digest('hex')
}

class CacheManager {
  #cacheDir
  #redis
  #inflight = new Map()
  #log
  #isRedisReady = false
  #retryTimer = null
  #retryIntervalMs
  #reconciling = false

  constructor(cacheDir, redisUrl, retryIntervalSec, log) {
    this.#cacheDir = cacheDir
    this.#retryIntervalMs = retryIntervalSec * 1000
    this.#log = log

    this.#redis = new Redis(redisUrl, {
      retryStrategy(times) {
        return Math.min(times * 200, 3000)
      },
    })

    this.#redis.on('ready', () => {
      this.#isRedisReady = true
      this.#log.info('Redis connection established')
      // If recovering from disconnect, reconcile immediately and stop retry loop
      if (this.#retryTimer) {
        this.#reconcile().then(() => this.#stopRetryLoop()).catch(() => {})
      }
    })

    this.#redis.on('close', () => {
      if (this.#isRedisReady) {
        this.#isRedisReady = false
        this.#log.warn('Redis connection lost — operating in degraded mode')
        this.#startRetryLoop()
      }
    })

    this.#redis.on('end', () => {
      this.#isRedisReady = false
    })

    this.#redis.on('error', (err) => {
      this.#log.warn({ err: err.message }, 'Redis error')
    })
  }

  get isRedisConnected() {
    return this.#isRedisReady
  }

  // --- Retry loop: periodically attempt to reconnect + reconcile ---

  #startRetryLoop() {
    if (this.#retryTimer) return // already running
    this.#log.info(`Starting Redis retry loop (every ${this.#retryIntervalMs / 1000}s)`)
    this.#retryTimer = setInterval(() => this.#attemptReconnect(), this.#retryIntervalMs)
  }

  #stopRetryLoop() {
    if (this.#retryTimer) {
      clearInterval(this.#retryTimer)
      this.#retryTimer = null
    }
  }

  async #attemptReconnect() {
    // ioredis may have already reconnected via its own retryStrategy
    if (this.#isRedisReady) {
      this.#log.info('Redis reconnected — running reconciliation')
      await this.#reconcile()
      this.#stopRetryLoop()
      return
    }

    this.#log.info('Redis still unavailable — will retry')
  }

  // --- Reconciliation: align disk ↔ Redis ---

  async #reconcile() {
    if (this.#reconciling) return
    this.#reconciling = true
    try {
      const actualFiles = new Set(await fs.readdir(this.#cacheDir))

      // Reconcile Redis → disk: drop Redis entries whose cache file no longer exists
      const redisKeys = new Set()
      let cursor = '0'
      do {
        const [nextCursor, keys] = await this.#redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
        cursor = nextCursor
        for (const redisKey of keys) {
          const cacheKey = redisKey.slice(KEY_PREFIX.length)
          redisKeys.add(cacheKey)
          if (!actualFiles.has(cacheKey)) {
            await this.#redis.del(redisKey)
            redisKeys.delete(cacheKey)
          }
        }
      } while (cursor !== '0')

      // Reconcile disk → Redis: delete orphan disk files with no Redis metadata
      for (const file of actualFiles) {
        if (file.startsWith('.tmp-')) continue
        if (!redisKeys.has(file)) {
          this.#log.warn({ file }, 'Removing orphan cache file (no Redis metadata)')
          await fs.unlink(path.join(this.#cacheDir, file)).catch(() => {})
        }
      }

      this.#log.info('Reconciliation complete')
    } catch (err) {
      this.#log.error({ err }, 'Reconciliation failed')
    } finally {
      this.#reconciling = false
    }
  }

  // --- Lifecycle ---

  async init() {
    await fs.mkdir(this.#cacheDir, { recursive: true })

    // Wait until Redis is ready (auto-connect with retry) — with timeout
    // If Redis is unavailable, start in degraded mode instead of throwing
    if (!this.#isRedisReady) {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Redis connection timed out after 10 s'))
          }, 10_000)
          this.#redis.once('ready', () => { clearTimeout(timer); resolve() })
        })
      } catch (err) {
        this.#log.warn({ err: err.message }, 'Redis unavailable at startup — operating in degraded mode')
        this.#startRetryLoop()
        return
      }
    }

    await this.#reconcile()
  }

  // --- Cache operations (all Redis-fault-tolerant) ---

  async get(urlPath) {
    if (!this.#isRedisReady) return { hit: false }

    const key = pathToKey(urlPath)
    try {
      const entry = await this.#redis.hgetall(`${KEY_PREFIX}${key}`)

      // Empty object means key does not exist
      if (!entry || Object.keys(entry).length === 0) return { hit: false }

      const cachedAt = Number(entry.cachedAt)
      const ttl = Number(entry.ttl)
      const elapsed = Date.now() - cachedAt

      if (elapsed > ttl * 1000) {
        // Lazy cleanup: expired → delete Redis key + disk file
        await this.#redis.del(`${KEY_PREFIX}${key}`)
        await fs.unlink(path.join(this.#cacheDir, key)).catch(() => {})
        return { hit: false, expired: true, key }
      }

      return {
        hit: true,
        filePath: path.join(this.#cacheDir, key),
        contentType: entry.contentType,
        key,
      }
    } catch (err) {
      this.#log.warn({ err: err.message, urlPath }, 'Redis read failed — treating as cache miss')
      return { hit: false }
    }
  }

  async set(urlPath, buffer, contentType, ttl) {
    if (!this.#isRedisReady) return null

    const key = pathToKey(urlPath)
    const filePath = path.join(this.#cacheDir, key)
    const tmpPath = path.join(this.#cacheDir, `.tmp-${key}`)

    // Atomic file write: tmp → rename
    try {
      await fs.writeFile(tmpPath, buffer)
      await fs.rename(tmpPath, filePath)
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {})
      throw err
    }

    // Store metadata in Redis HASH (single atomic HSET)
    try {
      await this.#redis.hset(`${KEY_PREFIX}${key}`,
        'originalPath', urlPath,
        'contentType', contentType || 'application/octet-stream',
        'size', buffer.length,
        'cachedAt', Date.now(),
        'ttl', ttl,
      )
    } catch (err) {
      // Redis write failed — remove the disk file to avoid orphan
      this.#log.warn({ err: err.message, urlPath }, 'Redis write failed — removing disk file to avoid orphan')
      await fs.unlink(filePath).catch(() => {})
      return null
    }

    return key
  }

  // Fetch from origin with in-flight deduplication
  // fetchFn: async () => { buffer, contentType }
  async fetchAndStore(urlPath, ttl, fetchFn) {
    const key = pathToKey(urlPath)

    const existing = this.#inflight.get(key)
    if (existing) return existing

    const promise = (async () => {
      const result = await fetchFn()
      try {
        await this.set(urlPath, result.buffer, result.contentType, ttl)
      } catch (err) {
        this.#log.error({ err, urlPath }, 'Cache write failed — serving without caching')
      }
      return result
    })()

    this.#inflight.set(key, promise)
    promise.finally(() => this.#inflight.delete(key)).catch(() => {})
    return promise
  }

  async delete(key) {
    const filePath = path.join(this.#cacheDir, key)
    await fs.unlink(filePath).catch(() => {})

    if (!this.#isRedisReady) return
    try {
      await this.#redis.del(`${KEY_PREFIX}${key}`)
    } catch (err) {
      this.#log.warn({ err: err.message, key }, 'Redis delete failed')
    }
  }

  async clearAll() {
    // Delete all disk cache files
    const files = await fs.readdir(this.#cacheDir)
    const toDelete = files.filter(f => !f.startsWith('.tmp-'))
    await Promise.all(
      toDelete.map(f => fs.unlink(path.join(this.#cacheDir, f)).catch(() => {}))
    )
    const count = toDelete.length

    // Delete all Redis metadata keys via SCAN + pipeline
    if (!this.#isRedisReady) return count
    try {
      let cursor = '0'
      do {
        const [nextCursor, keys] = await this.#redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
        cursor = nextCursor
        if (keys.length > 0) {
          const pipeline = this.#redis.pipeline()
          for (const k of keys) pipeline.del(k)
          await pipeline.exec()
        }
      } while (cursor !== '0')
    } catch (err) {
      this.#log.warn({ err: err.message }, 'Redis clearAll failed — disk files were still deleted')
    }

    return count
  }

  async list() {
    if (!this.#isRedisReady) return []

    try {
      const now = Date.now()
      const entries = []
      let cursor = '0'

      do {
        const [nextCursor, keys] = await this.#redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
        cursor = nextCursor

        if (keys.length > 0) {
          const pipeline = this.#redis.pipeline()
          for (const k of keys) pipeline.hgetall(k)
          const results = await pipeline.exec()

          for (let i = 0; i < keys.length; i++) {
            const [err, entry] = results[i]
            if (err || !entry || Object.keys(entry).length === 0) continue

            const cacheKey = keys[i].slice(KEY_PREFIX.length)
            const cachedAt = Number(entry.cachedAt)
            const ttl = Number(entry.ttl)

            entries.push({
              key: cacheKey,
              originalPath: entry.originalPath,
              contentType: entry.contentType,
              size: Number(entry.size),
              cachedAt,
              ttl,
              remainingTtl: Math.max(0, Math.ceil((cachedAt + ttl * 1000 - now) / 1000)),
            })
          }
        }
      } while (cursor !== '0')

      return entries
    } catch (err) {
      this.#log.warn({ err: err.message }, 'Redis list failed — returning empty list')
      return []
    }
  }

  async totalFiles() {
    if (!this.#isRedisReady) {
      // Fallback: count disk files
      const files = await fs.readdir(this.#cacheDir)
      return files.filter(f => !f.startsWith('.tmp-')).length
    }

    try {
      let count = 0
      let cursor = '0'
      do {
        const [nextCursor, keys] = await this.#redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
        cursor = nextCursor
        count += keys.length
      } while (cursor !== '0')
      return count
    } catch (err) {
      this.#log.warn({ err: err.message }, 'Redis totalFiles failed — falling back to disk count')
      const files = await fs.readdir(this.#cacheDir)
      return files.filter(f => !f.startsWith('.tmp-')).length
    }
  }

  async quit() {
    this.#stopRetryLoop()
    this.#isRedisReady = false // prevent 'close' handler from restarting retry loop
    await this.#redis.quit()
  }
}

async function cacheManagerPlugin(fastify) {
  const cacheDir = fastify.config.CACHE_DIR
  const redisUrl = fastify.config.REDIS_URL
  const retryInterval = fastify.config.REDIS_RETRY_INTERVAL
  const manager = new CacheManager(cacheDir, redisUrl, retryInterval, fastify.log)
  await manager.init()
  fastify.decorate('cache', manager)
  fastify.log.info(`Cache manager initialized — dir: ${cacheDir}, redis: ${redisUrl}`)

  // Graceful shutdown: close Redis connection
  fastify.addHook('onClose', async () => {
    await manager.quit()
  })
}

export default fp(cacheManagerPlugin, { name: 'cache-manager-plugin', dependencies: ['config-plugin'] })
