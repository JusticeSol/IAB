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

test('pairing codes are single use and unknown tokens are rejected', async () => {
  const { o, sent } = await setup()
  assert.equal(o.pair(sent[0].text.match(/\d{8}/)[0], 'UTC'), null)
  assert.equal(o.ownerFor('nope'), undefined)
})
