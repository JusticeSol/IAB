import { createServer } from 'node:http'
import { createIab } from './iab.js'
import { telegram } from './telegram.js'
import { createReader } from './llm.js'

const { TELEGRAM_BOT_TOKEN, TELEGRAM_API, DB_PATH = 'iab.db', PORT = '8787', DEFAULT_TZ = 'UTC' } = process.env
if (!TELEGRAM_BOT_TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env (see .env.example)')
  process.exit(1)
}

const tg = telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_API || undefined)
const read = createReader()
console.log(read ? `Plans read by Claude (${process.env.IAB_MODEL || "claude-haiku-5-5"})` : "No ANTHROPIC_API_KEY: plans found by keyword rules")
const iab = createIab({ db: DB_PATH, tg, tz: DEFAULT_TZ, read, log: (m) => console.log(new Date().toISOString(), m) })

// Global pairing throttle: 8-digit codes, at most 20 guesses a minute.
let guesses = 0
setInterval(() => { guesses = 0 }, 60_000).unref()

async function readBody(req) {
  let s = ''
  for await (const chunk of req) {
    s += chunk
    if (s.length > 4096) throw new Error('too large')
  }
  return JSON.parse(s || '{}')
}

createServer(async (req, res) => {
  const reply = (code, data) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    })
    res.end(data && JSON.stringify(data))
  }
  try {
    if (req.method === 'OPTIONS') return reply(204)
    const { pathname } = new URL(req.url, 'http://x')
    if (pathname === '/health') return reply(200, { ok: true })
    if (req.method === 'POST' && pathname === '/pair') {
      if (++guesses > 20) return reply(429, { error: 'Try again in a minute' })
      const b = await readBody(req)
      const token = iab.pair(b.code, b.tz)
      return token ? reply(200, { token }) : reply(401, { error: 'Wrong or expired code' })
    }
    const owner = iab.ownerFor(req.headers.authorization?.replace(/^Bearer /, ''))
    if (!owner) return reply(401, { error: 'Not paired' })
    if (req.method === 'GET' && pathname === '/next') return reply(200, { plan: iab.next(owner) })
    const m = pathname.match(/^\/plans\/(\d+)\/act$/)
    if (req.method === 'POST' && m) {
      const b = await readBody(req)
      return reply(200, await iab.act(owner, Number(m[1]), b.action, b.op))
    }
    reply(404, { error: 'Not found' })
  } catch (e) {
    console.error('request failed:', e.message)
    reply(400, { error: 'Bad request' })
  }
}).listen(Number(PORT), () => console.log(`IAB server on :${PORT}`))

let offset = 0
for (;;) {
  try {
    const updates = await tg('getUpdates', {
      offset, timeout: 25, allowed_updates: [], // all default kinds; unknown ones are logged and ignored
    }, 35_000)
    for (const u of updates) {
      offset = u.update_id + 1
      // Log the update kind only, never message text.
      console.log(new Date().toISOString(), 'update:', Object.keys(u).filter((k) => k !== 'update_id').join(','))
      try { await iab.onUpdate(u) } catch (e) { console.error('update failed:', e.message) }
    }
  } catch (e) {
    console.error(e.message)
    await new Promise((r) => setTimeout(r, 3000))
  }
}
