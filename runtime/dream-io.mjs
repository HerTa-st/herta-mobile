/**
 * dream-io.mjs — dream 管线在手机上的"磁盘"
 *
 * 桌面版的 dream（长期记忆）是一套完整的文件管线：narrative/ 下放废案、
 * dream/ 下放 manifest 与归档、还有锁文件与临时文件。手机上没有 fs，
 * 所以这里用一份**内存虚拟文件系统**顶替它，IndexedDB 只负责最后落盘。
 *
 * 关键点：web/assets/prompts-code.zh.mjs 里那 96 个函数是桌面版原文搬过来的，
 * 它们会调用下面这些名字；签名与语义都照着桌面版实现（见 tools/print-io-impl.mjs 打印的原码）。
 * 只要这里的行为对得上，手机端跑的就是她那套**原版 dream 算法**。
 */

/* ------------------------------------------------------------ 虚拟文件系统 */
let ROOT = 'herta-phone' // 相当于桌面版的 workspaceRoot
let FILES = new Map() // 完整路径 → 文本（narrative/ 与其它）
let LOCK = null // 单次 pass 的锁
let MANIFESTS = new Map() // dreamDir → manifest（桌面版是按语言各存一份）
const ARCHIVE = new Map()

/** 手机端启动时灌入已有记忆与 manifest */
export function configureDreamIO({
  workspaceRoot = 'herta-phone',
  files = {},
  archive = {},
  manifests = null,
  manifest = null, // 兼容旧存档：单份 manifest 会落到 zh 的 dreamDir
} = {}) {
  ROOT = workspaceRoot
  FILES = new Map(Object.entries(files))
  ARCHIVE.clear()
  for (const [k, v] of Object.entries(archive)) ARCHIVE.set(k, v)
  MANIFESTS = new Map()
  if (manifests && typeof manifests === 'object') {
    for (const [dir, m] of Object.entries(manifests)) MANIFESTS.set(dir, m)
  } else if (manifest) {
    MANIFESTS.set(dreamDirFor(workspaceRoot, 'zh'), manifest)
  }
  LOCK = null
}

/** dream 跑完后取回快照，由上层写进 IndexedDB */
export function snapshotDreamIO() {
  return {
    files: Object.fromEntries(FILES),
    archive: Object.fromEntries(ARCHIVE),
    manifests: Object.fromEntries(MANIFESTS),
  }
}

/** 当前记忆文件（给 UI 和语音样本池用） */
export function listMemoryFiles() {
  const dir = join$1(ROOT, '.herta', 'narrative')
  return [...FILES.keys()]
    .filter((p) => p.startsWith(dir + '/'))
    .map((p) => p.slice(dir.length + 1))
    .filter((f) => !f.includes('/'))
}

/* -------------------------------------------------------------- 路径helpers */
const SEP = '/'
export function join$1(...parts) {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '' && p !== false)
    .map(String)
    .join(SEP)
  return joined.replace(/\/{2,}/g, '/')
}
export function dirname$1(p) {
  const s = String(p)
  const i = s.lastIndexOf(SEP)
  return i <= 0 ? SEP : s.slice(0, i)
}
export function basename$1(p, ext) {
  let b = String(p).split(/[\\/]/).pop() ?? ''
  if (ext && b.endsWith(ext)) b = b.slice(0, b.length - String(ext).length)
  return b
}
export function resolve$1(p) {
  return String(p)
}
export function extname$1(p) {
  const b = basename$1(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i)
}

/* ------------------------------------------------------------------ 目录 */
export function narrativeDirFor(workspaceRoot, lang = 'zh') {
  return join$1(workspaceRoot || ROOT, '.herta', lang === 'en' ? 'narrative-en' : 'narrative')
}
export function dreamDirFor(workspaceRoot, lang = 'zh') {
  return join$1(workspaceRoot || ROOT, '.herta', lang === 'en' ? 'dream-en' : 'dream')
}
export function recapCachePath(workspaceRoot, sessionId) {
  return join$1(workspaceRoot || ROOT, '.herta', 'compaction', `${sessionId}.json`)
}

export async function listDir(dir) {
  const d = String(dir)
  const names = new Set()
  for (const p of FILES.keys()) {
    if (!p.startsWith(d + '/')) continue
    const rest = p.slice(d.length + 1)
    if (!rest.includes('/')) names.add(rest)
  }
  for (const p of ARCHIVE.keys()) {
    if (!p.startsWith(d + '/')) continue
    const rest = p.slice(d.length + 1)
    if (!rest.includes('/')) names.add(rest)
  }
  return [...names]
}
export function safeReaddir(dir) {
  const d = String(dir)
  const names = new Set()
  for (const p of [...FILES.keys(), ...ARCHIVE.keys()]) {
    if (!p.startsWith(d + '/')) continue
    const rest = p.slice(d.length + 1)
    if (!rest.includes('/')) names.add(rest)
  }
  return [...names]
}
export function listFeianFiles(narrativeDir) {
  return safeReaddir(narrativeDir)
    .filter((f) => f.startsWith('### 废案') && f.endsWith('.txt'))
    .sort()
}

/* ------------------------------------------------------------------ 读写 */
export function readTextFile(dir, file) {
  const p = join$1(dir, file)
  if (FILES.has(p)) return FILES.get(p)
  if (ARCHIVE.has(p)) return ARCHIVE.get(p)
  return undefined
}
export function readTextFileResult(dir, file) {
  const t = readTextFile(dir, file)
  return t === undefined ? { kind: 'absent' } : { kind: 'text', text: t }
}

/* ------------------------------------------------------------------ 时间等 */
export function now() {
  return new Date()
}
export function fail(code, message, summary) {
  return {
    ok: false,
    error: { code, message, retryable: false },
    summary: summary ?? `failed: ${code}`,
    modelText: message,
  }
}
export function interpreterName(a0 = 'phone') {
  return String(a0).split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase()
}
export function summarizeShellCommand(command) {
  // 手机上不跑 shell，只用于给提示词留一行摘要
  return String(command ?? '').trim().slice(0, 120)
}
export function ensureHertaGitignore() {
  // 手机上没有 git，也没有 .herta 目录要保护
}
export function assertUnderDreamRoot() {
  // 虚拟文件系统不存在"写穿到根目录之外"这回事
}

/* ------------------------------------------------------------------ 锁/manifest */
const LOCK_FILE = 'pass.lock'
const STALE_LOCK_MS = 10 * 60 * 1000

export function acquireDreamLock(dreamDir, nowMs) {
  if (LOCK && nowMs - LOCK.at < STALE_LOCK_MS) return undefined
  LOCK = { at: nowMs }
  return {
    release() {
      LOCK = null
    },
  }
}

export function emptyManifest() {
  return { version: 1, episodes: [], created: [] }
}

function normalizeCreated(r) {
  const sourceEpisodes =
    Array.isArray(r.sourceEpisodes) && r.sourceEpisodes.length > 0 ? r.sourceEpisodes : [r.sourceEpisodeHash]
  return {
    ...r,
    sourceEpisodes,
    reactivationCount: typeof r.reactivationCount === 'number' ? r.reactivationCount : 0,
  }
}

export function readManifest(dreamDir) {
  const m = MANIFESTS.get(String(dreamDir))
  if (!m) return emptyManifest()
  return {
    version: 1,
    episodes: m.episodes ?? [],
    created: (m.created ?? []).map(normalizeCreated),
    ...(m.lastRunAt !== undefined ? { lastRunAt: m.lastRunAt } : {}),
  }
}

export function writeManifest(dreamDir, m) {
  MANIFESTS.set(String(dreamDir), { ...m })
}

export function reconcileDreamState({ narrativeDir, manifest }) {
  const res = { sweptTemp: 0, prunedPhantom: 0 }
  const present = new Set(safeReaddir(narrativeDir))
  const kept = []
  for (const r of manifest.created ?? []) {
    if (present.has(r.file)) kept.push(r)
    else res.prunedPhantom++
  }
  manifest.created = kept
  // 只读的 seed（本来就有的样本）不进 manifest，这里不用管
  return res
}

/* ------------------------------------------------------- 归档 / 新废案 / 情节记账 */
export function archiveDreamRecord(manifest, target, narrativeDir, dreamDir, reason, nowFn) {
  if (!target?.file) return
  const src = join$1(narrativeDir, target.file)
  const body = FILES.get(src)
  if (body !== undefined) {
    ARCHIVE.set(join$1(dreamDir, 'archive', target.file), body)
    FILES.delete(src)
  }
  manifest.created = (manifest.created ?? []).filter((r) => r.file !== target.file)
  manifest.episodes = manifest.episodes ?? []
  manifest.episodes.push({
    at: (nowFn?.() ?? new Date()).toISOString(),
    outcome: 'archived',
    reason,
    file: target.file,
    id: target.id,
  })
}

export function archiveLiveRecord({ narrativeDir, dreamDir, file, reason }) {
  const src = join$1(narrativeDir, file)
  const body = FILES.get(src)
  if (body !== undefined) {
    ARCHIVE.set(join$1(dreamDir, 'archive', file), body)
    FILES.delete(src)
  }
  const m = MANIFESTS.get(String(dreamDir))
  if (m) {
    m.episodes = m.episodes ?? []
    m.episodes.push({ at: new Date().toISOString(), outcome: 'archived', reason, file })
  }
}

export function feianFileIndex(name) {
  const m = /^### 废案_(\d{2,})：/.exec(name)
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null
}

export function nextFeianIndex(existingFilenames) {
  let max = -1
  for (const f of existingFilenames) {
    const n = feianFileIndex(f)
    if (n !== null) max = Math.max(max, n)
  }
  return max + 1
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * 落一个新废案：文件名与正文头部都照桌面版的格式
 * （桌面版写的是 `### 废案_NN：<title>.txt`，正文以 `### 废案：<title>` 开头）
 */
export function promoteCandidate(input) {
  const { narrativeDir, title, feianBody, runId } = input
  const existing = safeReaddir(narrativeDir)
  const nn = nextFeianIndex(existing)
  const safeTitle = String(title || '未命名').replace(/[\\/:*?"<>|\n\r]/g, '').slice(0, 40)
  const file = `### 废案_${pad(nn)}：${safeTitle}.txt`
  const header = `### 废案：${safeTitle}`
  let body = String(feianBody ?? '').trim()
  // 正文若已自带头部就不重复加
  body = body.startsWith('### 废案') ? body : `${header}\n\n${body}`
  FILES.set(join$1(narrativeDir, file), body + '\n')
  return { nn, file, runId }
}

export function recordEpisode(manifest, ep, outcome, reason, nowFn) {
  manifest.episodes = manifest.episodes ?? []
  manifest.episodes.push({
    at: (nowFn?.() ?? new Date()).toISOString(),
    sessionId: ep?.sessionId,
    episodeHash: ep?.episodeHash,
    outcome,
    reason,
  })
}

export function reinforceRecord(m, id, atIso, spacingMs = 0) {
  const list = m.created ?? []
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return { reinforced: false, spaced: false }
  const rec = list[idx]
  const last = rec.lastReinforcedAt ?? rec.generatedAt
  const spaced = last !== undefined && spacingMs > 0 && Date.parse(atIso) - Date.parse(last) >= spacingMs
  const next = { ...rec, reactivationCount: (rec.reactivationCount ?? 0) + 1, lastReinforcedAt: atIso }
  m.created.splice(idx, 1, next)
  return { reinforced: true, spaced }
}

export function markGistFolded(m, ids) {
  const wanted = new Set(ids)
  for (let i = 0; i < m.created.length; i++) {
    const r = m.created[i]
    if (r === undefined || !wanted.has(r.id)) continue
    m.created.splice(i, 1, { ...r, gistFolded: true })
  }
}

/**
 * 给生成提示词注入"我脑子里已有的东西"：桌面版会去读 narrative/ 里的样本。
 * 这里把当前记忆库的标题+开头拼给她（这就是手机端『她记得』的来源）。
 */
export function dreamRelevantSystemBody(workspaceRoot, lang = 'zh', opts = {}) {
  const dir = narrativeDirFor(workspaceRoot, lang)
  const files = listFeianFiles(dir)
  if (!files.length) return ''
  const picked = typeof opts.max === 'number' ? files.slice(0, opts.max) : files.slice(0, 6)
  return picked
    .map((f) => {
      const body = FILES.get(join$1(dir, f)) ?? ''
      return body.slice(0, 900).trim()
    })
    .filter(Boolean)
    .join('\n\n')
}

export function dreamRelevantEvidenceDetail(workspaceRoot, lang = 'zh', opts = {}) {
  const dir = narrativeDirFor(workspaceRoot, lang)
  const files = listFeianFiles(dir)
  return files.map((f) => `- ${f}`).join('\n')
}

/* ------------------------------------------------ node 内建的替身（虚拟文件系统）*/
/** 目录在虚拟文件系统里就是路径前缀，直接当文件夹用，不需要真的建 */
export function mkdirSync() {}

export function existsSync(p) {
  const path = String(p)
  if (FILES.has(path) || ARCHIVE.has(path)) return true
  return [...FILES.keys(), ...ARCHIVE.keys()].some((k) => k.startsWith(path + '/'))
}

export function readdirSync(dir) {
  return safeReaddir(dir)
}

export function writeFileSync(p, data) {
  const path = String(p)
  FILES.set(path, typeof data === 'string' ? data : String(data ?? ''))
}

export function renameSync(from, to) {
  const a = String(from)
  const b = String(to)
  const body = FILES.get(a) ?? ARCHIVE.get(a)
  if (body === undefined) return
  FILES.delete(a)
  ARCHIVE.delete(a)
  FILES.set(b, body)
}

export function copyFileSync(from, to) {
  const body = FILES.get(String(from)) ?? ARCHIVE.get(String(from))
  if (body !== undefined) FILES.set(String(to), body)
}

export function unlinkSync(p) {
  FILES.delete(String(p))
  ARCHIVE.delete(String(p))
}

export function statSync(p) {
  const path = String(p)
  if (FILES.has(path) || ARCHIVE.has(path)) return { size: (FILES.get(path) ?? ARCHIVE.get(path) ?? '').length, isFile: () => true, isDirectory: () => false }
  return { size: 0, isFile: () => false, isDirectory: () => true }
}

export function readFileSync(p) {
  const path = String(p)
  const body = FILES.get(path) ?? ARCHIVE.get(path)
  if (body === undefined) {
    const err = new Error(`ENOENT: ${path}`)
    err.code = 'ENOENT'
    throw err
  }
  return body
}

export function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/* ------------------------------------------- node:fs/promises 的异步替身 */
export async function readFile(p, enc) {
  return enc ? readFileSync(p) : new TextEncoder().encode(readFileSync(p))
}
export async function writeFile(p, data) {
  writeFileSync(p, data)
}
export async function mkdir() {}
export async function readdir(dir) {
  return safeReaddir(dir)
}
export async function rename(from, to) {
  renameSync(from, to)
}
export async function unlink(p) {
  unlinkSync(p)
}
export async function copyFile(from, to) {
  copyFileSync(from, to)
}
export async function stat(p) {
  return statSync(p)
}

/* ------------------------------------------------------------- 同步 SHA-256 */
/* episodeHash 要用它（桌面版是 node:crypto 的 createHash("sha256")）。
   浏览器里 crypto.subtle 是异步的，这里给一个纯 JS 的同步实现。 */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input))
  const len = bytes.length
  const withOne = new Uint8Array((((len + 8) >> 6) + 1) << 6)
  withOne.set(bytes)
  withOne[len] = 0x80
  const bitLen = len * 8
  const view = new DataView(withOne.buffer)
  view.setUint32(withOne.length - 4, bitLen >>> 0)
  view.setUint32(withOne.length - 8, Math.floor(bitLen / 0x100000000))

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))

  for (let off = 0; off < withOne.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('')
}

/** node:crypto 的 createHash("sha256").update(x).digest("hex") */
export function createHash() {
  let buf = ''
  return {
    update(chunk) {
      buf += String(chunk)
      return this
    },
    digest() {
      return sha256Hex(buf)
    },
  }
}
