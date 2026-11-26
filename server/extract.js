import * as chrono from 'chrono-node'

const MEET = /\b(meet|see you|see u|lunch|dinner|coffee|breakfast|drinks|catch up|come by|swing by)\b/i
const SETTLED = /\b(see you|see u)\b/i
const YES = /^\s*(?:(?:ok(?:ay)?|yes|yep|yeah|sure|perfect|great|deal|sounds good|works|that works|see you|see u)\b|👍)/i
const NO = /\b(can['’]?t|cannot|won['’]?t|not|cancel)\b/i
const HOUR = 3600_000

export function tzOffsetMinutes(tz, date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(date).map((x) => [x.type, Number(x.value)]))
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
}

/** A message that names a meetup time. Returns null for anything else. */
export function findPlan(text, sentAt, tz) {
  if (!MEET.test(text) || NO.test(text)) return null
  const ref = { instant: sentAt, timezone: tzOffsetMinutes(tz, sentAt) }
  const hit = chrono.parse(text, ref, { forwardDate: true }).find((r) => r.start.isCertain('hour'))
  if (!hit) return null

  let at = hit.start.date().getTime()
  // "at 3" means the afternoon: nobody meets for coffee at 3am.
  const hour = hit.start.get('hour')
  const relative = /\b(min(ute)?s?|h(ou)?rs?)\b/i.test(hit.text)
  if (!relative && !hit.start.isCertain('meridiem') && hour >= 1 && hour < 8) at += 12 * HOUR
  // The parser may have pushed an ambiguous hour to tomorrow.
  const dayGiven = hit.start.isCertain('day') || hit.start.isCertain('weekday')
  if (!dayGiven && at - 24 * HOUR > sentAt.getTime()) at -= 24 * HOUR
  if (at <= sentAt.getTime()) return null

  const rest = text.replace(hit.text, ' ')
  const place = rest.match(/(?:\b(?:at|in)|@)\s+(?:the\s+)?(\p{L}[\p{L}\d'’& ]{1,28})/iu)?.[1].trim() || null
  return { at, place, settled: SETTLED.test(text) }
}

export const isYes = (text) => YES.test(text) && !NO.test(text)

/** "2026-11-26T17:00" in tz -> epoch ms, or null if malformed. */
export function localToEpoch(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? '')
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  // Correct twice so a DST edge between the guess and the answer still lands right.
  let at = wall - tzOffsetMinutes(tz, new Date(wall)) * 60_000
  at = wall - tzOffsetMinutes(tz, new Date(at)) * 60_000
  return Number.isFinite(at) ? at : null
}
