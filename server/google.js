import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'

const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const LINK_TTL = 15 * 60_000
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

/**
 * Google Calendar for IAB: a sign-in link per Telegram user, then clash checks and one-tap event creation.
 * Returns null when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.
 */
export function createCalendar({
  db: path, clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET,
  publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`, now = Date.now,
}) {
  if (!clientId || !clientSecret) return null
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS google (owner INTEGER PRIMARY KEY, refresh_token TEXT);
    CREATE TABLE IF NOT EXISTS google_links (state TEXT PRIMARY KEY, owner INTEGER, expires INTEGER);
  `)
  const q = (sql) => db.prepare(sql)
  const redirectUri = `${publicUrl}/google/callback`
  const access = new Map() // owner -> { token, expires }, in memory only

  async function token(body) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`google token: ${data.error ?? res.status}`)
    return data
  }

  async function accessFor(owner) {
    const cached = access.get(owner)
    if (cached && cached.expires > now() + 60_000) return cached.token
    const row = q('SELECT refresh_token FROM google WHERE owner = ?').get(owner)
    if (!row) return null
    try {
      const t = await token({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
      access.set(owner, { token: t.access_token, expires: now() + t.expires_in * 1000 })
      return t.access_token
    } catch (e) {
      // Access was revoked in the Google account: forget it so the card stops offering calendar actions.
      if (/invalid_grant/.test(e.message)) q('DELETE FROM google WHERE owner = ?').run(owner)
      throw e
    }
  }

  async function call(owner, url, init = {}) {
    const t = await accessFor(owner)
    if (!t) throw new Error('google: not connected')
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`google calendar: ${data.error?.status ?? res.status}`)
    return data
  }

  return {
    connected: (owner) => !!q('SELECT 1 FROM google WHERE owner = ?').get(owner),

    /** A one-time sign-in link to send the user in Telegram. */
    linkFor(owner) {
      const state = randomBytes(24).toString('base64url')
      q('DELETE FROM google_links WHERE owner = ? OR expires < ?').run(owner, now())
      q('INSERT INTO google_links VALUES (?, ?, ?)').run(state, owner, now() + LINK_TTL)
      return `${publicUrl}/google/start?s=${state}`
    },

    /** GET /google/start: send the browser to Google's consent screen. */
    startUrl(state) {
      if (!q('SELECT 1 FROM google_links WHERE state = ? AND expires > ?').get(state, now())) return null
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state,
      })
    },

    /** GET /google/callback: returns the owner id that connected, or null. */
    async finish(state, code) {
      const link = q('SELECT * FROM google_links WHERE state = ? AND expires > ?').get(state, now())
      if (!link || !code) return null
      q('DELETE FROM google_links WHERE state = ?').run(state)
      const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
      if (!t.refresh_token) throw new Error('google: no refresh token')
      q(`INSERT INTO google VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET refresh_token = excluded.refresh_token`)
        .run(link.owner, t.refresh_token)
      access.set(link.owner, { token: t.access_token, expires: now() + t.expires_in * 1000 })
      return link.owner
    },

    /**
     * The first timed event overlapping [from, to) that is not this plan, as { summary, start }, plus the id of
     * the event that is this plan (IAB's own id, or the same title at the same start) so it is not added twice.
     */
    async clash(owner, from, to, self = {}) {
      const data = await call(owner, `${API}?` + new URLSearchParams({
        timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '10',
      }))
      const timed = (data.items ?? []).filter((e) => e.start?.dateTime && e.status !== 'cancelled')
      const isSelf = (e) => e.id === self.id || (e.summary === self.title && Date.parse(e.start.dateTime) === from)
      const hit = timed.find((e) => !isSelf(e) && e.transparency !== 'transparent')
      return {
        clash: hit ? { summary: hit.summary || 'Busy', start: Date.parse(hit.start.dateTime) } : null,
        mine: timed.find(isSelf)?.id ?? null,
      }
    },

    /** Creates the event and returns its id. */
    async add(owner, { summary, location, from, to }) {
      const e = await call(owner, API, {
        method: 'POST',
        body: JSON.stringify({
          summary, location: location ?? undefined,
          start: { dateTime: new Date(from).toISOString() }, end: { dateTime: new Date(to).toISOString() },
          description: 'Agreed in Telegram. Added from IAB on Even G2.',
        }),
      })
      return e.id
    },
  }
}
