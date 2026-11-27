// Runs a whole chat through the real Claude reader and prints the card after each step.
// node --env-file=.env dev/try-flow.js
import { createIab } from '../server/iab.js'
import { createReader } from '../server/llm.js'

const read = createReader()
const sent = []
const tg = async (method, b) => { sent.push(b); return { message_id: sent.length } }
const o = createIab({ tg, read, tz: 'Africa/Lagos', log: (m) => console.log('   log:', m) })
await o.onUpdate({ business_connection: { id: 'c', user: { id: 1 }, user_chat_id: 1, is_enabled: true, rights: { can_reply: true } } })
const token = o.pair(sent[0].text.match(/\d{8}/)[0], 'Africa/Lagos')
const me = () => o.ownerFor(token)
let n = 0
const say = (from, text, bot = false) => o.onUpdate({ business_message: {
  message_id: ++n, business_connection_id: 'c', date: Math.floor(Date.now() / 1000), from: { id: from },
  chat: { id: 2, type: 'private', first_name: 'Jerpi' }, text, ...(bot && { sender_business_bot: { id: 99 } }) } })
const show = (step) => {
  const p = o.next(me())
  console.log(`${step}\n   card: ${p ? `${p.state}${p.going ? ' (confirmed)' : ''} ${new Date(p.at).toISOString().slice(11, 16)}Z ${p.activity ?? ''} | ${p.actions.map((a) => a.label).join(' / ')}` : 'none'}`)
}
const tap = async (label) => {
  const p = o.next(me())
  const a = p?.actions.find((x) => x.label === label)
  if (!a) return console.log(`   !! no "${label}" on the card`)
  const r = await o.act(me(), p.id, a.id, `op-${a.id}-${n}`)
  await say(1, r.text, true) // Telegram echoes what the bot sent as a business message
  show(`ME taps "${label}" -> ${r.status}`)
}

await say(2, 'leg day by 5pm. outside lobby or indoor arena?'); show('JERPI: leg day by 5pm. outside lobby or indoor arena?')
await tap('Indoor arena')
await say(2, 'okay'); show('JERPI: okay')
await tap("I'll be there")
await say(2, 'alright, see you there'); show('JERPI: alright, see you there')
await tap("I'm here")
await say(2, 'cool, coming down now'); show('JERPI: cool, coming down now')
