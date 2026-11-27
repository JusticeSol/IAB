import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIab } from '../server/iab.js'
import { findPlan, isYes } from '../server/extract.js'
import { TelegramError } from '../server/telegram.js'

const T0 = Date.UTC(2026, 10, 25, 8, 0) // 12:00 in Dubai
const dubai = (s) => Date.parse(s + '+04:00')

test('extracts time and place', () => {
  const f = (t) => findPlan(t, new Date(T0), 'Asia/Dubai')
  assert.deepEqual(f('coffee at 3 at Cafe Nero?'), { at: dubai('2026-11-25T15:00:00'), place: 'Cafe Nero', settled: false })
  assert.equal(f('meet at 3pm?').at, dubai('2026-11-25T15:00:00'))
  assert.equal(f('lunch tomorrow at 13:30').at, dubai('2026-11-26T13:30:00'))
  assert.equal(f('meet tomorrow at 3?').at, dubai('2026-11-26T15:00:00'))
  assert.equal(f('see you at 4pm').settled, true)
  for (const t of ['the price hit 3 today', "can't meet at 3", 'meet soon?', 'i woke at 3']) assert.equal(f(t), null, t)
  assert.ok(isYes('Sounds good') && isYes('👍') && !isYes("ok but I can't"))
})

async function setup(fail) {
  let clock = T0
  const sent = []
  const tg = async (_, b) => {
    if (b.business_connection_id && fail) throw fail
    sent.push(b)
  }
  const o = createIab({ tg, now: () => clock })
  await o.onUpdate({ business_connection: { id: 'c', user: { id: 1 }, user_chat_id: 1, is_enabled: true, rights: { can_reply: true } } })
  const token = o.pair(sent[0].text.match(/\d{8}/)[0], 'Asia/Dubai')
  const msg = (from, text) => o.onUpdate({ business_message: {
    business_connection_id: 'c', date: clock / 1000, from: { id: from },
    chat: { id: 2, type: 'private', first_name: 'Sam', username: 'sam' }, text } })
  await msg(2, 'coffee at 3 at Cafe Nero?')
  return { o, sent, msg, me: () => o.ownerFor(token), tick: (ms) => { clock += ms } }
}

test('a plan needs agreement, then one tap sends once', async () => {
  const { o, sent, msg, me } = await setup()
  assert.equal(o.next(me()), null)
  await msg(2, 'ok?')
  assert.equal(o.next(me()), null, 'a proposer cannot agree with themselves')
  await msg(1, 'sounds good')
  const p = o.next(me())
  assert.equal(p.name, 'Sam')
  const [a, b] = await Promise.all([o.act(me(), p.id, 'onway', 'x'), o.act(me(), p.id, 'onway', 'x')])
  assert.equal(a.status, 'sent')
  assert.notEqual(b.status, 'handoff')
  assert.equal(sent.filter((s) => s.business_connection_id).length, 1)
  assert.equal((await o.act(me(), p.id, 'late', 'y')).status, 'sent')
  assert.equal(o.next(me()).at - p.at, 600_000)
  await o.act(me(), p.id, 'here', 'z')
  assert.equal(o.next(me()), null)
  assert.equal((await o.act(me(), p.id, 'here', 'z')).status, 'sent', 'retry of the closing tap')
})

test('closed window and refusals hand off; network failure is unknown', async () => {
  const cases = [[null, 25 * 3600_000, 'handoff'], [new TelegramError('x'), 0, 'handoff'], [new Error('net'), 0, 'unknown']]
  for (const [fail, wait, want] of cases) {
    const { o, msg, me, tick } = await setup(fail)
    await msg(1, 'sure')
    const { id } = o.next(me())
    tick(wait)
    assert.equal((await o.act(me(), id, 'onway', 'x')).status, want)
  }
})

test('a message on an unknown connection looks the connection up and pairs', async () => {
  const sent = []
  const tg = async (method, b) => {
    if (method === 'getBusinessConnection') {
      return { id: b.business_connection_id, user: { id: 1 }, user_chat_id: 1, is_enabled: true, rights: { can_reply: true } }
    }
    sent.push(b)
  }
  const o = createIab({ tg, now: () => T0 })
  await o.onUpdate({ business_message: {
    business_connection_id: 'c', date: T0 / 1000, from: { id: 2 },
    chat: { id: 2, type: 'private', first_name: 'Sam' }, text: 'coffee at 3 at Cafe Nero?' } })
  assert.match(sent[0].text, /pairing code: \d{8}/)
  const token = o.pair(sent[0].text.match(/\d{8}/)[0], 'Asia/Dubai')
  assert.ok(o.ownerFor(token))
})

async function setupReader(answers) {
  const sent = []
  const tg = async (_, b) => { sent.push(b) }
  let next = 0
  const read = async () => {
    const a = answers[next++]
    if (a instanceof Error) throw a
    return a
  }
  const o = createIab({ tg, now: () => T0, read })
  await o.onUpdate({ business_connection: { id: 'c', user: { id: 1 }, user_chat_id: 1, is_enabled: true, rights: { can_reply: true } } })
  const token = o.pair(sent[0].text.match(/\d{8}/)[0], 'Asia/Dubai')
  const msg = (from, text) => o.onUpdate({ business_message: {
    business_connection_id: 'c', date: T0 / 1000, from: { id: from },
    chat: { id: 2, type: 'private', first_name: 'Tunde', username: 'tunde' }, text } })
  return { o, sent, msg, me: () => o.ownerFor(token) }
}

const legDay = (status, extra = {}) => ({
  plan: { status, proposed_by: 'them', local_time: '2026-11-25T17:00', place: null, activity: 'Leg day', ...extra },
  options: [],
})

test('their proposal with a question becomes a card with those answers', async () => {
  const { o, sent, msg, me } = await setupReader([
    { ...legDay('proposed'), options: ['Outside lobby', 'Indoor arena'] },
  ])
  await msg(2, 'leg day by 5. outside lobby or indoor arena?')
  const p = o.next(me())
  assert.equal(p.state, 'proposed')
  assert.equal(p.activity, 'Leg day')
  assert.equal(p.at, dubai('2026-11-25T17:00:00'))
  assert.deepEqual(p.actions.map((a) => a.label), ['Outside lobby', 'Indoor arena', "Can't make it"])
  assert.equal((await o.act(me(), p.id, 'opt1', 'a')).status, 'sent')
  assert.equal(sent.at(-1).text, 'Indoor arena')
  const after = o.next(me())
  assert.equal(after.state, 'agreed', 'answering the question accepts the plan')
  assert.equal(after.id, p.id)
  assert.deepEqual(after.actions.map((a) => a.id), ['onway', 'late', 'here'])
})

test('my own proposal shows nothing until they accept; cancel clears it', async () => {
  const { o, msg, me } = await setupReader([
    legDay('proposed', { proposed_by: 'me' }),
    legDay('agreed', { proposed_by: 'me' }),
    legDay('cancelled'),
  ])
  await msg(1, 'leg day at 5?')
  assert.equal(o.next(me()), null)
  await msg(2, 'bet')
  assert.equal(o.next(me()).state, 'agreed')
  await msg(2, 'actually cancel, I am sick')
  assert.equal(o.next(me()), null)
})

test('a re-read keeps my "10 min late"; a real time change replaces it', async () => {
  const { o, msg, me } = await setupReader([
    legDay('agreed'), legDay('agreed'), legDay('agreed', { local_time: '2026-11-25T16:30' }),
  ])
  await msg(2, 'leg day 5pm?')
  const p = o.next(me())
  await o.act(me(), p.id, 'late', 'l')
  await msg(2, 'cool')
  assert.equal(o.next(me()).at, p.at + 600_000)
  await msg(2, 'make it 4:30 instead')
  assert.equal(o.next(me()).at, dubai('2026-11-25T16:30:00'))
})

test('when Claude fails, keyword rules still find the plan', async () => {
  const { o, msg, me } = await setupReader([new Error('down'), null])
  await msg(2, 'coffee at 3 at Cafe Nero?')
  await msg(1, 'sounds good')
  assert.equal(o.next(me()).place, 'Cafe Nero')
})

test('calendar: a clash shows on the card and one tap adds the plan once', async () => {
  const sent = []
  const added = []
  const tg = async (_, b) => { sent.push(b) }
  let busy = { summary: 'Standup', start: dubai('2026-11-25T17:30:00') }
  const cal = {
    connected: () => true,
    linkFor: () => 'https://iab.example/google/start?s=x',
    clash: async (_o, from, to) => ({ clash: busy && busy.start < to && busy.start >= from ? busy : null, mine: null }),
    add: async (_o, ev) => { added.push(ev); return 'ev1' },
  }
  const read = async () => legDay('agreed')
  const o = createIab({ tg, now: () => T0, read, cal })
  await o.onUpdate({ business_connection: { id: 'c', user: { id: 1 }, user_chat_id: 1, is_enabled: true, rights: { can_reply: true } } })
  assert.match(sent[0].text, /\/calendar/)
  const token = o.pair(sent[0].text.match(/\d{8}/)[0], 'Asia/Dubai')
  const me = () => o.ownerFor(token)
  await o.onUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/calendar' } })
  assert.match(sent.at(-1).text, /google\/start/)

  await o.onUpdate({ business_message: {
    business_connection_id: 'c', date: T0 / 1000, from: { id: 2 },
    chat: { id: 2, type: 'private', first_name: 'Tunde' }, text: 'leg day 5pm?' } })
  const p = o.next(me())
  assert.deepEqual(p.clash, busy)
  assert.deepEqual(p.actions.map((a) => a.id), ['onway', 'late', 'here', 'cal'])
  const [a, b] = await Promise.all([o.act(me(), p.id, 'cal', 'k'), o.act(me(), p.id, 'cal', 'k')])
  assert.equal(a.status, 'added')
  assert.equal(b.status === 'added' || b.status === 'unknown', true)
  assert.equal(added.length, 1)
  assert.equal(added[0].summary, 'Leg day with Tunde')
  assert.equal(o.next(me()).actions.some((x) => x.id === 'cal'), false, 'no second add')

  busy = null
  await o.act(me(), p.id, 'late', 'l')
  assert.equal(o.next(me()).clash, null, 'moving the plan re-checks the calendar')
})

test("calendar: the plan's own event is not a clash and is not added again", async () => {
  const sent = []
  const tg = async (_, b) => { sent.push(b) }
  let self
  const cal = {
    connected: () => true,
    linkFor: () => 'x',
    clash: async (_o, _from, _to, s) => { self = s; return { clash: null, mine: 'old-ev' } },
    add: async () => { throw new Error('should not add') },
  }
  const o = createIab({ tg, now: () => T0, read: async () => legDay('agreed'), cal })
  await o.onUpdate({ business_connection: { id: 'c', user: { id: 1 }, user_chat_id: 1, is_enabled: true, rights: { can_reply: true } } })
  const token = o.pair(sent[0].text.match(/\d{8}/)[0], 'Asia/Dubai')
  await o.onUpdate({ business_message: {
    business_connection_id: 'c', date: T0 / 1000, from: { id: 2 },
    chat: { id: 2, type: 'private', first_name: 'Tunde' }, text: 'leg day 5pm?' } })
  assert.equal(self.title, 'Leg day with Tunde')
  const p = o.next(o.ownerFor(token))
  assert.equal(p.clash, null)
  assert.equal(p.actions.some((a) => a.id === 'cal'), false, 'already on the calendar')
})

test('pairing codes are single use and unknown tokens are rejected', async () => {
  const { o, sent } = await setup()
  assert.equal(o.pair(sent[0].text.match(/\d{8}/)[0], 'UTC'), null)
  assert.equal(o.ownerFor('nope'), undefined)
})
