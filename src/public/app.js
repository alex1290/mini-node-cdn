const POLL_INTERVAL = 4000 // ms

// ── DOM helpers ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function ttlBadge(remainingTtl) {
  let cls = 'ttl-badge'
  if (remainingTtl <= 0)  cls += ' expired'
  else if (remainingTtl < 30) cls += ' expiring'
  const label = remainingTtl <= 0 ? '已過期' : `${remainingTtl}s`
  return `<span class="${cls}">${label}</span>`
}

// ── Stats polling ─────────────────────────────────────────────────────────────
async function refreshStats() {
  try {
    const res = await fetch('/api/stats')
    if (!res.ok) return
    const { total_files, hit_count, miss_count } = await res.json()
    $('total-files').textContent = total_files
    $('hit-count').textContent   = hit_count
    $('miss-count').textContent  = miss_count
    const total = hit_count + miss_count
    $('hit-rate').textContent = total > 0
      ? `${((hit_count / total) * 100).toFixed(1)}%`
      : '—'
    $('last-updated').textContent = `最後更新：${new Date().toLocaleTimeString()}`
  } catch {/* silent */}
}

// ── Cache list polling ────────────────────────────────────────────────────────
async function refreshCacheList() {
  try {
    const res = await fetch('/api/cache')
    if (!res.ok) return
    const entries = await res.json()
    const tbody = $('cache-body')

    if (entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">目前無快取</td></tr>'
      return
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-family:monospace">${escHtml(e.originalPath)}</td>
        <td>${escHtml(e.contentType)}</td>
        <td>${formatBytes(e.size)}</td>
        <td>${ttlBadge(e.remainingTtl)}</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteEntry('${escHtml(e.key)}', '${escHtml(e.originalPath)}')">
            刪除
          </button>
        </td>
      </tr>
    `).join('')
  } catch {/* silent */}
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Delete single entry ───────────────────────────────────────────────────────
async function deleteEntry(key, originalPath) {
  if (!confirm(`確定刪除快取 "${originalPath || key}"？`)) return
  try {
    await fetch(`/api/cache/${encodeURIComponent(key)}`, { method: 'DELETE' })
    await Promise.all([refreshStats(), refreshCacheList()])
  } catch {/* silent */}
}
window.deleteEntry = deleteEntry

// ── Clear all cache ───────────────────────────────────────────────────────────
$('clear-btn').addEventListener('click', async () => {
  if (!confirm('確定清除所有快取？')) return
  const btn = $('clear-btn')
  btn.disabled = true
  try {
    const res = await fetch('/api/cache', { method: 'DELETE' })
    const data = await res.json()
    alert(`已清除 ${data.deletedCount} 個快取檔案`)
    await Promise.all([refreshStats(), refreshCacheList()])
  } catch {
    alert('清除失敗，請稍後再試')
  } finally {
    btn.disabled = false
  }
})

// ── Load settings ─────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return
    const s = await res.json()
    $('defaultTtl').value         = s.defaultTtl
    $('allowedExtensions').value  = (s.allowedExtensions || []).join(',')
    $('pathRules').value          = JSON.stringify(s.pathRules || [], null, 2)
  } catch {/* silent */}
}

// ── Save settings ─────────────────────────────────────────────────────────────
$('settings-form').addEventListener('submit', async e => {
  e.preventDefault()
  const msg = $('settings-msg')

  let pathRules
  try {
    pathRules = JSON.parse($('pathRules').value || '[]')
  } catch {
    msg.style.color = '#ef4444'
    msg.textContent = '路徑規則 JSON 格式錯誤'
    return
  }

  const extRaw = $('allowedExtensions').value.trim()
  const allowedExtensions = extRaw
    ? extRaw.split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean)
    : []

  const payload = {
    defaultTtl: parseInt($('defaultTtl').value, 10),
    allowedExtensions,
    pathRules,
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    msg.style.color = res.ok ? '#22c55e' : '#ef4444'
    msg.textContent = res.ok ? '設定已儲存 ✓' : data.message || '儲存失敗'
    setTimeout(() => { msg.textContent = '' }, 3000)
  } catch {
    msg.style.color = '#ef4444'
    msg.textContent = '儲存失敗，請稍後再試'
  }
})

// ── Initial load + polling ────────────────────────────────────────────────────
async function init() {
  await Promise.all([refreshStats(), refreshCacheList(), loadSettings()])
  setInterval(() => Promise.all([refreshStats(), refreshCacheList()]), POLL_INTERVAL)
}

init()
