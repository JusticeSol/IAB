import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { findPlan, isYes } from './extract.js'
import { TelegramError } from './telegram.js'

const DAY = 24 * 3600_000
const GRACE = 2 * 3600_000
const CODE_TTL = 10 * 60_000
const hash = (s) => createHash('sha256').update(s).digest('hex')

export const ACTIONS = {
  onway: 'On my way!',
  late: 'Running 10 minutes late, sorry!',
  here: "I'm here!",
}

export function createIab({ db: path = ':memory:', tg, tz = 'UTC', now = Date.now }) {
  const db = new DatabaseSync(path)
  // Only extracted plans are stored, never message text.
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (id INTEGER PRIMARY KEY, conn TEXT, can_reply INTEGER, tz TEXT, token TEXT);
    CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, owner INTEGER, expires INTEGER);
    CREATE TABLE IF NOT EXISTS chats (owner INTEGER, chat INTEGER, name TEXT, username TEXT, last_in INTEGER,
      draft_at INTEGER, draft_place TEXT, draft_mine INTEGER, PRIMARY KEY (owner, chat));
    CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY, owner INTEGER, chat INTEGER, at INTEGER, place TEXT,
      status TEXT DEFAULT 'open', UNIQUE (owner, chat));
    CREATE TABLE IF NOT EXISTS sends (owner INTEGER, op TEXT, result TEXT, PRIMARY KEY (owner, op));
  `)
  const q = (sql) => db.prepare(sql)

  async function sendCode(owner, dm) {
    const code = String(randomInt(0, 1e8)).padStart(8, '0')
    q('DELETE FROM codes WHERE owner = ?').run(owner)
    q('INSERT INTO codes VALUES (?, ?, ?)').run(code, owner, now() + CODE_TTL)
    await tg('sendMessage', { chat_id: dm, text: `Your IAB pairing code: ${code}\nIt expires in 10 minutes.` })
  }

  async function onConnection(c) {
    const canReply = c.is_enabled && c.rights?.can_reply ? 1 : 0
    q(`INSERT INTO owners (id, conn, can_reply, tz) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET conn = excluded.conn, can_reply = excluded.can_reply`)
      .run(c.user.id, c.is_enabled ? c.id : null, canReply, tz)
    if (c.is_enabled) await sendCode(c.user.id, c.user_chat_id)
  }

  function onBusinessMessage(m) {
    // Skip group chats and messages we sent ourselves.
    if (m.chat.type !== 'private' || m.sender_business_bot) return
    const owner = q('SELECT * FROM owners WHERE conn = ?').get(m.business_connection_id)
    if (!owner) return
    const mine = m.from?.id === owner.id ? 1 : 0
    const sent = m.date * 1000
    q(`INSERT INTO chats (owner, chat, name, username, last_in) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner, chat) DO UPDATE SET name = excluded.name, username = excluded.username,
         last_in = MAX(last_in, excluded.last_in)`)
      .run(owner.id, m.chat.id, m.chat.first_name ?? 'Contact', m.chat.username ?? null, mine ? 0 : sent)

    const text = m.text ?? ''
    const found = findPlan(text, new Date(sent), owner.tz)
    const chat = q('SELECT * FROM chats WHERE owner = ? AND chat = ?').get(owner.id, m.chat.id)
    if (found?.settled) {
      savePlan(owner.id, m.chat.id, found.at, found.place ?? chat.draft_place)
    } else if (found) {
      q('UPDATE chats SET draft_at = ?, draft_place = ?, draft_mine = ? WHERE owner = ? AND chat = ?')
        .run(found.at, found.place, mine, owner.id, m.chat.id)
    } else if (chat.draft_at > sent && chat.draft_mine !== mine && isYes(text)) {
      savePlan(owner.id, m.chat.id, chat.draft_at, chat.draft_place)
    }
  }

  function savePlan(owner, chat, at, place) {
    // One live plan per chat. A new plan gets a new id so a stale card cannot act on it.
    q('DELETE FROM plans WHERE owner = ? AND chat = ?').run(owner, chat)
    q('INSERT INTO plans (id, owner, chat, at, place) VALUES (?, ?, ?, ?, ?)')
      .run(randomInt(1, 2 ** 47), owner, chat, at, place)
    q('UPDATE chats SET draft_at = NULL, draft_place = NULL, draft_mine = NULL WHERE owner = ? AND chat = ?')
      .run(owner, chat)
  }

  async function onUpdate(u) {
    if (u.business_connection) await onConnection(u.business_connection)
    if (u.business_message) {
      // Telegram does not always send business_connection, so look up an unknown connection on first use.
      const id = u.business_message.business_connection_id
      if (id && !q('SELECT 1 FROM owners WHERE conn = ?').get(id)) {
        await onConnection(await tg('getBusinessConnection', { business_connection_id: id }))
      }
      onBusinessMessage(u.business_message)
    }
    const m = u.message
    if (m?.chat.type === 'private' && m.text?.startsWith('/start')) {
      const owner = q('SELECT * FROM owners WHERE id = ?').get(m.from.id)
      if (owner?.conn) await sendCode(owner.id, m.chat.id)
      else await tg('sendMessage', {
        chat_id: m.chat.id,
        text: 'Connect me to your account first, in Telegram settings. Pick the chats I may see and allow replies.',
      })
    }
  }

  function pair(code, zone) {
    const row = q('SELECT * FROM codes WHERE code = ? AND expires > ?').get(String(code), now())
    if (!row) return null
    let safeZone = tz
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone })
      safeZone = zone || tz
    } catch { /* keep the default */ }
    const token = randomBytes(32).toString('base64url')
    q('DELETE FROM codes WHERE code = ?').run(row.code)
    q('UPDATE owners SET token = ?, tz = ? WHERE id = ?').run(hash(token), safeZone, row.owner)
    return token
  }

  const ownerFor = (token) => token ? q('SELECT * FROM owners WHERE token = ?').get(hash(token)) : undefined

  const PLAN = `SELECT p.id, p.at, p.place, p.chat, c.name, c.username, c.last_in
    FROM plans p JOIN chats c ON c.owner = p.owner AND c.chat = p.chat`

  function next(owner) {
    const p = q(`${PLAN} WHERE p.owner = ? AND p.status = 'open' AND p.at > ? ORDER BY p.at LIMIT 1`)
      .get(owner.id, now() - GRACE)
    return p ? { id: p.id, name: p.name, at: p.at, place: p.place } : null
  }

  async function act(owner, id, action, op) {
    if (!Object.hasOwn(ACTIONS, action) || typeof op !== 'string' || !op || op.length > 64) {
      return { status: 'bad_request' }
    }
    const text = ACTIONS[action]
    // A retried tap must never send twice.
    const prior = q('SELECT result FROM sends WHERE owner = ? AND op = ?').get(owner.id, op)
    if (prior) return JSON.parse(prior.result)
    const p = q(`${PLAN} WHERE p.owner = ? AND p.id = ? AND p.status = 'open'`).get(owner.id, id)
    if (!p) return { status: 'not_found' }
    q('INSERT INTO sends VALUES (?, ?, ?)').run(owner.id, op, JSON.stringify({ status: 'unknown' }))
    const finish = (r) => {
      q('UPDATE sends SET result = ? WHERE owner = ? AND op = ?').run(JSON.stringify(r), owner.id, op)
      return r
    }

    const handoff = { status: 'handoff', text, username: p.username }
    if (!owner.conn || !owner.can_reply || now() - p.last_in > DAY) return finish(handoff)
    try {
      await tg('sendMessage', { business_connection_id: owner.conn, chat_id: p.chat, text })
    } catch (e) {
      // A refusal is safe to hand off. After a network failure it may have been delivered.
      return finish(e instanceof TelegramError ? handoff : { status: 'unknown' })
    }
    if (action === 'late') q('UPDATE plans SET at = at + 600000 WHERE id = ?').run(id)
    if (action === 'here') q("UPDATE plans SET status = 'done' WHERE id = ?").run(id)
    return finish({ status: 'sent', text })
  }

  return { onUpdate, pair, ownerFor, next, act, close: () => db.close() }
}
