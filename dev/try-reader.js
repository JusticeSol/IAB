// Runs the Claude reader on sample chats and prints what it extracts.
// Usage: node --env-file=.env dev/try-reader.js
import { createReader } from '../server/llm.js'

const read = createReader()
if (!read) throw new Error('Set ANTHROPIC_API_KEY in .env')

const tz = 'Africa/Lagos'
const now = Date.parse('2026-11-26T10:00:00+01:00')
const at = (min) => now - min * 60_000
const chats = {
  'gym bro, question': [[false, 'Bro leg day by 5pm today. We using the outside lobby or the indoor arena?']],
  'gym bro, agreed slang': [[false, 'chest day 6?'], [true, 'say less']],
  'running club, Saturday': [[false, 'Saturday run 6:30am from the stadium gate, you coming?'], [true, 'I dey come']],
  'my proposal, no answer': [[true, 'lunch tomorrow 1pm at the mall?']],
  'cancelled': [[false, 'coffee at 4 at Cafe Neo?'], [true, 'sure'], [false, 'abeg let us shift it, something came up']],
  'not a meetup': [[false, 'BTC hit 120k at 3am lol']],
}

for (const [name, lines] of Object.entries(chats)) {
  const started = Date.now()
  const r = await read(lines.map(([mine, text], i) => ({ mine, text, at: at(lines.length - i) })), { tz, now })
  console.log(`\n${name} (${Date.now() - started} ms)\n `, JSON.stringify(r))
}
