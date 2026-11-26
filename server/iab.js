import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { findPlan, isYes, localToEpoch } from './extract.js'
import { TelegramError } from './telegram.js'

const DAY = 24 * 3600_000
const GRACE = 2 * 3600_000
const CODE_TTL = 10 * 60_000
const KEEP_LINES = 12
const KEEP_FOR = 12 * 3600_000
const hash = (s) => createHash('sha256').update(s).digest('hex')

export const ACTIONS = {
  onway: { label: 'On my way', text: 'On my way!' },
  late: { label: '10 min late', text: 'Running 10 minutes late, sorry!' },
  here: { label: "I'm here", text: "I'm here!" },
  in: { label: "I'm in", text: "I'm in 👍" },
  cant: { label: "Can't make it", text: "Can't make it, sorry!" },
}

/** The replies a card offers, in order. Options the friend asked for come first. */
export function actionsFor(p) {
  const opts = (p.options ? JSON.parse(p.options) : []).map((o, i) => ({ id: `opt${i}`, label: o, text: o }))
  const base = p.state === 'proposed'
    ? [...(opts.length ? [] : ['in']), 'cant']
    : ['onway', 'late', ...(opts.length ? [] : ['here'])]
  return [...opts, ...base.map((id) => ({ id, ...ACTIONS[id] }))]
}

/**
 * read (optional): async (lines, { tz, now }) => ReadSchema result or null. Without it, keyword rules find plans.
 */
export function createIab({ db: path = ':memory:', tg, tz = 'UTC', now = Date.now, read = null, log = () => {} }) {
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
  for (const col of ["state TEXT DEFAULT 'agreed'", 'activity TEXT', 'options TEXT', 'late_by INTEGER DEFAULT 0']) {
    try { db.exec(`ALTER TABLE plans ADD COLUMN ${col}`) } catch { /* already there */ }
  }
  const q = (sql) => db.prepare(sql)

  // Recent lines per chat, in memory only, so Claude can read the conversation. Never written to disk.
  const recent = new Map()
  function remember(owner, chat, line) {
    const key = `${owner}:${chat}`
    const lines = (recent.get(key) ?? []).filter((l) => line.at - l.at < KEEP_FOR)
    lines.push(line)
    recent.set(key, lines.slice(-KEEP_LINES))
    return recent.get(key)
  }

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

  async function onBusinessMessage(m) {
    if (m.chat.type !== 'private') return
    const owner = q('SELECT * FROM owners WHERE conn = ?').get(m.business_connection_id)
    if (!owner) return
    const sent = m.date * 1000
    const text = m.text ?? m.caption ?? ''
    // What our bot sent is context for later messages, but never a new plan.
    if (m.sender_business_bot) {
      remember(owner.id, m.chat.id, { mine: true, text, at: sent })
      return
    }
    const mine = m.from?.id === owner.id ? 1 : 0
    q(`INSERT INTO chats (owner, chat, name, username, last_in) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner, chat) DO UPDATE SET name = excluded.name, username = excluded.username,
         last_in = MAX(last_in, excluded.last_in)`)
      .run(owner.id, m.chat.id, m.chat.first_name ?? 'Contact', m.chat.username ?? null, mine ? 0 : sent)
    const lines = remember(owner.id, m.chat.id, { mine: !!mine, text, at: sent })
    if (!text) return

    if (read) {
      try {
        const r = await read(lines, { tz: owner.tz, now: now() })
        if (r) {
          applyRead(owner, m.chat.id, r)
          return
        }
        log('reader gave no answer; using rules')
      } catch (e) {
        log(`reader failed (${e?.constructor?.name ?? 'Error'}); using rules`)
      }
    }
    applyRules(owner, m.chat.id, text, sent, mine)
  }

  function applyRules(owner, chatId, text, sent, mine) {
    const found = findPlan(text, new Date(sent), owner.tz)
    const chat = q('SELECT * FROM chats WHERE owner = ? AND chat = ?').get(owner.id, chatId)
    if (found?.settled) {
      upsertPlan(owner.id, chatId, { at: found.at, place: found.place ?? chat.draft_place })
    } else if (found) {
      q('UPDATE chats SET draft_at = ?, draft_place = ?, draft_mine = ? WHERE owner = ? AND chat = ?')
        .run(found.at, found.place, mine, owner.id, chatId)
    } else if (chat.draft_at > sent && chat.draft_mine !== mine && isYes(text)) {
      upsertPlan(owner.id, chatId, { at: chat.draft_at, place: chat.draft_place })
    }
  }

  function applyRead(owner, chatId, { plan, options }) {
    const open = q("SELECT * FROM plans WHERE owner = ? AND chat = ? AND status = 'open'").get(owner.id, chatId)
    if (!plan) return
    if (plan.status === 'cancelled') {
      if (open) q("UPDATE plans SET status = 'done' WHERE id = ?").run(open.id)
      return
    }
    const at = localToEpoch(plan.local_time, owner.tz)
    if (!at || at < now() - GRACE) return
    // A plan I proposed waits for their answer; there is nothing for me to tap yet.
    if (plan.status === 'proposed' && plan.proposed_by === 'me' && open?.state !== 'agreed') return
    const clip = (s, n) => (s ? String(s).trim().slice(0, n) || null : null)
    const opts = (options ?? []).map((o) => clip(o, 20)).filter(Boolean).slice(0, 2)
    upsertPlan(owner.id, chatId, {
      at,
      place: clip(plan.place, 24) ?? open?.place ?? null,
      activity: clip(plan.activity, 20),
      state: plan.status === 'agreed' || open?.state === 'agreed' ? 'agreed' : 'proposed',
      options: opts.length ? JSON.stringify(opts) : null,
    })
  }

  function upsertPlan(owner, chat, { at, place, activity = null, state = 'agreed', options = null }) {
    const open = q("SELECT * FROM plans WHERE owner = ? AND chat = ? AND status = 'open'").get(owner, chat)
    if (open && Math.abs(open.at - at) <= 3600_000) {
      // Same meetup: keep the id so the card on the glasses stays valid.
      // Our own "10 min late" moved the stored time; a re-read of the chat still sees the original.
      const unchanged = at === open.at - open.late_by
      q('UPDATE plans SET at = ?, late_by = ?, place = ?, activity = ?, state = ?, options = ? WHERE id = ?')
        .run(unchanged ? open.at : at, unchanged ? open.late_by : 0, place, activity ?? open.activity, state, options, open.id)
    } else {
      // A new time gets a new id so a stale card cannot act on it.
      q('DELETE FROM plans WHERE owner = ? AND chat = ?').run(owner, chat)
      q('INSERT INTO plans (id, owner, chat, at, place, state, activity, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomInt(1, 2 ** 47), owner, chat, at, place, state, activity, options)
    }
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
      await onBusinessMessage(u.business_message)
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

  const PLAN = `SELECT p.id, p.at, p.place, p.chat, p.state, p.activity, p.options, c.name, c.username, c.last_in
    FROM plans p JOIN chats c ON c.owner = p.owner AND c.chat = p.chat`

  function next(owner) {
    const p = q(`${PLAN} WHERE p.owner = ? AND p.status = 'open' AND p.at > ? ORDER BY p.at LIMIT 1`)
      .get(owner.id, now() - GRACE)
    if (!p) return null
    return {
      id: p.id, name: p.name, at: p.at, place: p.place, activity: p.activity, state: p.state,
      actions: actionsFor(p).map(({ id, label }) => ({ id, label })),
    }
  }

  async function act(owner, id, actionId, op) {
    if (typeof actionId !== 'string' || typeof op !== 'string' || !op || op.length > 64) return { status: 'bad_request' }
    // A retried tap must never send twice.
    const prior = q('SELECT result FROM sends WHERE owner = ? AND op = ?').get(owner.id, op)
    if (prior) return JSON.parse(prior.result)
    const p = q(`${PLAN} WHERE p.owner = ? AND p.id = ? AND p.status = 'open'`).get(owner.id, id)
    if (!p) return { status: 'not_found' }
    const action = actionsFor(p).find((a) => a.id === actionId)
    if (!action) return { status: 'not_found' }
    const { text } = action
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
    if (actionId.startsWith('opt') || actionId === 'in') {
      q("UPDATE plans SET state = 'agreed', options = NULL WHERE id = ?").run(id)
    }
    if (actionId === 'late') q('UPDATE plans SET at = at + 600000, late_by = late_by + 600000 WHERE id = ?').run(id)
    if (actionId === 'here' || actionId === 'cant') q("UPDATE plans SET status = 'done' WHERE id = ?").run(id)
    return finish({ status: 'sent', text })
  }

  return { onUpdate, pair, ownerFor, next, act, close: () => db.close() }
}
