# Mini-Node-CDN 代理快取服務

一個以 [Fastify](https://fastify.dev/) 實作的 CDN 代理快取伺服器。收到 GET 請求時判斷本地快取是否命中，命中直接回傳並附上 `X-Cache: HIT`；未命中或已過期則從源頭伺服器抓取，寫入快取後回傳並附上 `X-Cache: MISS`。

## 功能特色

| 功能 | 說明 |
|------|------|
| 代理快取 | GET 請求自動代理並快取到本地 `cache/` |
| TTL 過期機制 | 快取檔案超過設定秒數後視為過期，重新從源頭抓取 |
| `X-Cache` 標頭 | 每個回應標示 `HIT` 或 `MISS` |
| Stats API | `/api/stats` 提供命中/缺失計數、快取檔案數、Redis 連線狀態 |
| 快取管理 API | 列出、清除所有或單一快取項目 |
| 設定 API | 動態調整 TTL、允許的副檔名、路徑規則 |
| Dashboard UI | `/dashboard` 即時監控面板（Polling + Vanilla JS） |
| 原子化寫入 | Write-then-Rename 確保檔案寫入不損壞 |
| 並行安全 | In-flight Deduplication 避免相同資源重複抓取 |
| Redis 持久化 | RDB 快照 + named volume，重啟不遺失快取 metadata |
| Redis 離線降級 | Redis 斷線時自動降級為直接代理模式，不中斷服務；定時檢測並自動重連 |
| Docker 部署 | Dockerfile + docker-compose.yml |

## 快速啟動

### 方式一：Docker Compose（推薦）

```bash
# 複製環境設定範例
cp backend/.env.example backend/.env
cp backend/settings.json.example backend/settings.json

# 啟動 CDN 服務與 Mock Origin Server
docker compose up --build
```

服務啟動後：
- **CDN 代理**：`http://localhost:3000`
- **Dashboard**：`http://localhost:8081`
- **Mock Origin**：`http://localhost:8080`

> `cache/`、`settings.json` 與 Redis 資料皆透過 volume 掛載，容器重啟後資料持久保留。Redis 預設啟用 RDB 快照（每 60 秒有變更時自動存檔）。容器檔案系統為 `read_only`，僅 `/tmp` 可寫入。

### 方式二：本地開發執行

> **前置需求**：需要先啟動 Redis（預設連線 `redis://localhost:6379`），可透過 `docker run -d -p 6379:6379 redis:7-alpine` 快速啟動。

```bash
cd backend

# 安裝依賴
npm install

# 設定環境變數（請先啟動一個源頭伺服器與 Redis）
export ORIGIN_URL=http://localhost:8080
export DEFAULT_TTL=120

# 啟動
npm start

# 或啟動並監聽檔案變更（開發模式）
npm run dev
```

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `PORT` | `3000` | 伺服器監聽 port |
| `HOST` | `0.0.0.0` | 伺服器監聽 host |
| `ORIGIN_URL` | `http://localhost:8080` | 源頭伺服器 URL |
| `DEFAULT_TTL` | `120` | 預設快取有效秒數 |
| `CACHE_DIR` | `./cache` | 快取檔案存放路徑 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 連線 URL |
| `REDIS_RETRY_INTERVAL` | `60` | Redis 斷線後重連檢測間隔（秒） |
| `REDIS_CONNECT_TIMEOUT` | `10` | Redis 啟動連線逾時（秒） |
| `SETTINGS_FILE` | `./settings.json` | 動態設定檔路徑 |
| `NODE_ENV` | `development` | 執行環境（`development` 關閉靜態資源快取） |

## API 路由

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/*` | CDN 代理核心（wildcard） |
| `GET` | `/api/stats` | 取得統計數據 |
| `GET` | `/api/cache` | 列出所有快取項目 |
| `DELETE` | `/api/cache` | 清除所有快取 |
| `DELETE` | `/api/cache/:key` | 清除指定快取 |
| `GET` | `/api/settings` | 取得設定 |
| `PUT` | `/api/settings` | 更新設定 |
| `GET` | `/dashboard` | 管理面板 |

### 設定範例（PUT /api/settings）

```json
{
  "defaultTtl": 300,
  "allowedExtensions": ["jpg", "png", "css", "js"],
  "pathRules": [
    { "path": "/images/", "ttl": 3600, "cache": true },
    { "path": "/api/",    "ttl": 0,    "cache": false }
  ]
}
```

- `allowedExtensions`：空陣列表示快取所有副檔名
- `pathRules`：按陣列順序匹配（第一個 `startsWith` 命中的規則生效），`cache: false` 表示此路徑完全不快取

## 技術實作：TTL 過期邏輯

快取元資料儲存於 Redis HASH（key 格式 `cache:meta:{key}`），每個項目包含欄位：

| 欄位 | 說明 |
|------|------|
| `originalPath` | 原始請求路徑 |
| `contentType` | 回應的 Content-Type |
| `size` | 檔案大小（bytes） |
| `cachedAt` | 快取建立的 Unix timestamp（ms） |
| `ttl` | 有效期（秒） |

**過期判斷**：
```
Date.now() - entry.cachedAt > entry.ttl * 1000
```

當請求 `GET /hello.txt` 時：
1. 查 metadata，計算經過的毫秒數
2. 若超過 `ttl × 1000`，視為過期（回傳 MISS）
3. 重新從源頭抓取，覆蓋舊快取並更新 `cachedAt`

**原子化寫入**：先寫入 `.tmp-{key}` 暫存檔，完成後 `fs.rename()` 為正式檔名。`fs.rename` 在同一檔案系統是原子操作，防止寫到一半的損壞快取。伺服器啟動時會自動清理殘留的 `.tmp-*` 暫存檔，並刪除所有無對應 Redis metadata 的孤立快取檔案。

## 測試

```bash
cd backend
npm test
```

使用 Node.js 內建 `node:test`（零額外依賴），測試時建立獨立 temp 目錄與 Mock Origin Server，不佔用正式 port。

### 手動驗證（curl）

```bash
# 1. 第一次請求 — MISS
curl -I http://localhost:3000/index.html
# X-Cache: MISS

# 2. 第二次請求 — HIT
curl -I http://localhost:3000/index.html
# X-Cache: HIT

# 3. 查看統計
curl http://localhost:3000/api/stats
# {"total_files":1,"hit_count":1,"miss_count":1,"redis_connected":true}

# 4. 清除所有快取
curl -X DELETE http://localhost:3000/api/cache
# {"message":"Cache cleared","deletedCount":1}

# 5. 再次請求 — 清除後重新 MISS
curl -I http://localhost:3000/index.html
# X-Cache: MISS
```

## 專案結構

```
cdnServer/
├── backend/                       # 後端（Fastify CDN 代理伺服器）
│   ├── src/
│   │   ├── plugins/
│   │   │   ├── cache-manager.js   # 快取核心：TTL、原子寫入、並行安全
│   │   │   ├── config.js          # 環境變數集中管理
│   │   │   ├── settings.js        # 動態設定（TTL、允許類型、路徑規則）
│   │   │   └── stats.js           # HIT/MISS 計數器
│   │   ├── routes/
│   │   │   ├── index.js           # GET /* — CDN 代理 wildcard
│   │   │   └── api/
│   │   │       ├── cache/         # GET/DELETE /api/cache
│   │   │       ├── settings/      # GET/PUT /api/settings
│   │   │       └── stats/         # GET /api/stats
│   │   ├── server.js              # buildServer() 工廠
│   │   └── app.js                 # 進入點 + graceful shutdown
│   ├── test/                      # node:test 測試套件
│   ├── cache/                     # 快取儲存（Docker volume）
│   ├── settings.json              # 動態設定檔（Docker volume）
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
├── frontend/                      # 前端（Dashboard 監控面板）
│   ├── public/
│   │   ├── index.html             # Dashboard 頁面
│   │   ├── app.js                 # Dashboard 邏輯
│   │   └── style.css              # Dashboard 樣式
│   ├── nginx.conf                 # Nginx 設定（反向代理 /api → 後端）
│   └── Dockerfile
├── docker/origin-files/           # Mock Origin 靜態檔案
└── docker-compose.yml
```

## 開發挑戰

**並行寫入安全（In-flight Deduplication）**  
當大量請求同時 MISS 同一資源，若無處理會對源頭發出大量重複請求，且多個 `fs.writeFile` 會 race condition 互相覆蓋。解法：用 `Map<cacheKey, Promise>` 記錄進行中的抓取，後續相同 key 的請求等待同一 Promise，fetch 完成後統一移除。

**一致性（Redis ↔ 磁碟雙向同步）**  
原子化寫入，再 `redis.hset()` 寫入 metadata。若伺服器在兩步之間崩潰，磁碟上會殘留 Redis 查不到的孤立檔案。啟動時 `init()` 執行雙向同步：刪除 Redis 有但磁碟無的 key，同時刪除磁碟有但 Redis 無的孤立檔案，確保兩端一致。Redis 以 source of truth 為準。

**Redis 離線降級**  
Redis 斷線不會阻止伺服器啟動或中斷服務。所有快取操作透過 `#isRedisReady` 狀態旗標自動降級：`get()` 回傳 MISS、`set()` 跳過寫入（避免產生無 metadata 的孤立檔案）、`list()` 回傳空陣列、`totalFiles()` 退回用 `fs.readdir()` 計算磁碟檔案數。斷線後每隔 `REDIS_RETRY_INTERVAL` 秒（預設 60）檢測 Redis 狀態，ioredis 自動重連成功後立即執行 reconciliation 對齊磁碟與 Redis，恢復完整快取功能。

**效能平衡**  
過期清理採懶惰策略（lazy expiration）——僅在資源被再次請求時才判定過期並刪除，冷門資源即使已過期仍永久佔用磁碟空間，無背景回收機制，應該新增一個機制固定刪除冷門資源，但有dashboard供使用者自行刪除，所以此機制優先級不高，除非磁碟爆滿。

**串流即時回應（Teeing Stream）— 未完成**  
目前 cache MISS 時，`fetchFromOrigin()` 使用 `Buffer.from(await response.arrayBuffer())` 將源頭回應完整載入記憶體，寫入快取後才 `reply.send(buffer)` 回應客戶端。大檔案會造成明顯延遲——客戶端必須等伺服器下載完畢並寫入磁碟後才收到第一個 byte。理想做法是用 Tee Stream 將源頭回應同時分流至客戶端與快取磁碟寫入，讓客戶端即時收到資料。但此機制涉及串流中斷的錯誤處理、原子化寫入語意的改變、以及 In-flight Deduplication 的 Promise 機制需配合調整，尚未實作。
