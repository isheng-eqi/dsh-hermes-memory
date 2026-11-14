/** Pure, portable owner-maintenance helpers; also bundled in the sandbox. */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => JSON.parse(JSON.stringify(value))
const banks = ['memory', 'user']
const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
const rotate = (value, count) => value >>> count | value << (32 - count)
/** SHA-256 of canonical JSON with UTF-8 encoding, including lone-surrogate replacement. */
export function payloadSha256(value) {
  const text = canonical(value), bytes = []
  for (let index = 0; index < text.length; index++) {
    let point = text.codePointAt(index)
    if (point > 0xffff) index++
    else if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
    if (point < 0x80) bytes.push(point)
    else if (point < 0x800) bytes.push(0xc0 | point >>> 6, 0x80 | point & 63)
    else if (point < 0x10000) bytes.push(0xe0 | point >>> 12, 0x80 | point >>> 6 & 63, 0x80 | point & 63)
    else bytes.push(0xf0 | point >>> 18, 0x80 | point >>> 12 & 63, 0x80 | point >>> 6 & 63, 0x80 | point & 63)
  }
  const length = bytes.length
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(length / 0x20000000), low = length * 8 >>> 0
  for (const word of [high, low]) bytes.push(word >>> 24 & 255, word >>> 16 & 255, word >>> 8 & 255, word & 255)
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64)
    for (let i = 0; i < 16; i++) words[i] = bytes[offset + i * 4] << 24 | bytes[offset + i * 4 + 1] << 16 | bytes[offset + i * 4 + 2] << 8 | bytes[offset + i * 4 + 3]
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2]
      words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10)) | 0
    }
    let [a,b,c,d,e,f,g,h] = state
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + k[i] + words[i]) | 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c)) | 0
      h=g; g=f; f=e; e=d+t1|0; d=c; c=b; b=a; a=t1+t2|0
    }
    for (const [i, word] of [a,b,c,d,e,f,g,h].entries()) state[i] = state[i] + word | 0
  }
  return state.map(word => (word >>> 0).toString(16).padStart(8, '0')).join('')
}

export function validateRuntime(data) {
  if (!isObject(data) || data.format !== 1 || !isObject(data.pending) || !isObject(data.reviews)) throw new Error('Malformed memory runtime metadata')
  for (const [key, record] of Object.entries(data.pending)) {
    if (!isObject(record) || typeof record.status !== 'string') throw new Error('Malformed proposal: ' + key)
    const pins = record.pins ?? record.pinnedIdentities
    if (pins !== undefined && (!Array.isArray(pins) || pins.some(pin => !isObject(pin) || (pin.staged !== true && (!Number.isSafeInteger(pin.seq) || pin.seq < 1)) || !Number.isSafeInteger(pin.operation) || pin.operation < 0))) throw new Error('Malformed proposal identities: ' + key)
  }
  for (const [key, record] of Object.entries(data.reviews)) {
    if (!isObject(record) || typeof record.status !== 'string' || !Number.isSafeInteger(record.turn) || record.turn < 0) throw new Error('Malformed review claim: ' + key)
  }
  return data
}

export function compactRuntime(data, { before, maxDetailed = 100, now = new Date().toISOString() } = {}) {
  validateRuntime(data)
  if (!isoTime(before)) throw new Error('Specify before as an ISO timestamp with a timezone')
  if (!isoTime(now)) throw new Error('Invalid compaction timestamp')
  if (!Number.isSafeInteger(maxDetailed) || maxDetailed < 0 || maxDetailed > 10000) throw new Error('maxDetailed must be an integer from 0 to 10000')
  const result = copy(data), counts = { pending: 0, reviews: 0 }
  for (const collection of ['pending', 'reviews']) {
    const terminal = collection === 'pending' ? ['approved', 'discarded'] : ['completed', 'error', 'failed', 'cancelled', 'max-iterations', 'interrupted']
    const detailed = Object.entries(data[collection]).filter(([, row]) => !row.compacted && terminal.includes(row.status) && isoTime(row.finishedAt))
      .sort(([a, x], [b, y]) => Date.parse(y.finishedAt) - Date.parse(x.finishedAt) || a.localeCompare(b))
    for (const [key, row] of detailed.slice(maxDetailed)) {
      if (Date.parse(row.finishedAt) >= Date.parse(before)) continue
      const marker = { compacted: true, compactedAt: now, payloadSha256: payloadSha256(row) }
      for (const name of ['id', 'target', 'sessionId', 'turn', 'status', 'createdAt', 'startedAt', 'finishedAt', 'iterations', 'writes', 'pending', 'toolCalls']) {
        if (row[name] !== undefined) marker[name] = copy(row[name])
      }
      if (collection === 'pending') marker.pinnedIdentities = (row.pins || row.pinnedIdentities || []).map(({ operation, seq, staged }) => staged === true ? { operation, staged: true } : { operation, seq })
      Object.defineProperty(result[collection], key, { value: marker, enumerable: true, configurable: true, writable: true })
      counts[collection]++
    }
  }
  return { data: result, summary: { changed: counts.pending + counts.reviews > 0, compactedProposals: counts.pending, compactedReviews: counts.reviews,
    proposalMarkers: Object.keys(result.pending).length, reviewMarkers: Object.keys(result.reviews).length, before, maxDetailed,
    note: 'Old resolved payloads compacted; all replay markers and unresolved approval evidence retained. Total metadata size is not capped.' } }
}

function memoryTables(snapshot) {
  if (!isObject(snapshot) || !isObject(snapshot.tables) || !Object.hasOwn(snapshot, 'global')) throw new Error('Malformed memory snapshot')
  if (snapshot.global !== null && (!isObject(snapshot.global) || snapshot.global.format !== 2)) throw new Error('Unsupported memory snapshot format')
  const tables = snapshot.global === null ? snapshot.tables : snapshot.global.tables
  if (!isObject(tables)) throw new Error('Malformed memory tables')
  for (const bank of banks) {
    if (!isObject(tables[bank])) throw new Error('Malformed memory bank: ' + bank)
    const seen = new Set()
    for (const row of Object.values(tables[bank])) {
      if (!isObject(row) || typeof row.text !== 'string' || !Number.isSafeInteger(row.seq) || row.seq < 1 || seen.has(row.seq)) throw new Error('Malformed memory record in ' + bank)
      seen.add(row.seq)
    }
    const high = snapshot.global?.seqHighWater
    if (high !== undefined && (!isObject(high) || !Number.isSafeInteger(high[bank]) || high[bank] < [...seen].reduce((maximum, seq) => Math.max(maximum, seq), 0))) throw new Error('Malformed memory sequence high-water')
  }
  return tables
}

export function createMemoryExport(memorySnapshot, runtimeSnapshot, { createdAt = new Date().toISOString() } = {}) {
  if (!isoTime(createdAt)) throw new Error('Invalid export timestamp')
  const tables = memoryTables(memorySnapshot)
  if (!isObject(runtimeSnapshot) || !isObject(runtimeSnapshot.tables) || !Object.hasOwn(runtimeSnapshot, 'global')) throw new Error('Malformed runtime snapshot')
  if (runtimeSnapshot.global !== null) validateRuntime(runtimeSnapshot.global)
  return { format: 1, createdAt,
    entries: Object.fromEntries(banks.map(bank => [bank, Object.values(tables[bank]).sort((a, b) => a.seq - b.seq).map(row => row.text)])),
    bookkeeping: { memorySnapshot: copy(memorySnapshot), runtimeSnapshot: copy(runtimeSnapshot) },
    v1Document: { unit: { name: 'hermes_memory', version: 1 }, global: null, tables: copy(tables) },
    warnings: ['Private owner export includes disabled banks and full bookkeeping.', 'The v1 document contains current entries only; runtime claims and proposals remain exclusively in bookkeeping.', 'Stop all writers, keep both original files, and use a separate directory for downgrade recovery. This export does not install a downgrade.'],
  }
}
