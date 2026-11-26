import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

// What Claude returns for one chat. Times are local wall-clock so the model never does timezone math.
export const ReadSchema = z.object({
  plan: z.object({
    status: z.enum(['proposed', 'agreed', 'cancelled']),
    proposed_by: z.enum(['me', 'them']),
    local_time: z.string().describe('YYYY-MM-DDTHH:MM in the user\'s timezone'),
    place: z.string().nullable().describe('Short place name, at most 24 characters'),
    activity: z.string().nullable().describe('Two or three words, e.g. "Leg day", "Coffee", "Saturday run"'),
  }).nullable(),
  options: z.array(z.string()).describe(
    'Choices THEY asked ME to pick between and I have not answered yet, as short replies I could send ' +
    '(at most 2, each at most 16 characters). Empty if there is no open question.'),
})

const SYSTEM = `You read a private Telegram chat between me and one friend and track the single meetup we are arranging.
Return the current state of the latest meetup, or plan = null if no meetup with a specific time is being arranged.
- "agreed": both of us have accepted a specific time (e.g. "leg day at 5?" then "bet", "say less", "👍", "sounds good").
- "proposed": one side suggested a specific time and the other has not accepted yet.
- "cancelled": the latest meetup was called off.
Read slang and Nigerian, British and American English naturally. Ignore times that are not meetups ("price hit 3", "I woke at 3").
"at 5" means 17:00 unless context says morning. If I said I am running late, keep the agreed time. Never invent a time that was not said or clearly implied.
Options: only a pending question from them to me with distinct choices, e.g. "outside lobby or indoor arena?" -> ["Outside lobby", "Indoor arena"].`

export function createReader({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.IAB_MODEL || 'claude-opus-5-5' } = {}) {
  if (!apiKey) return null
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 })

  /** lines: [{ mine, text, at }] oldest first. Returns ReadSchema output, or null if Claude gave no usable answer. */
  return async function read(lines, { tz, now = Date.now() }) {
    const clock = (t) => new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(t)
    const transcript = lines.map((l) => `[${clock(l.at)}] ${l.mine ? 'Me' : 'Them'}: ${l.text}`).join('\n')
    const response = await client.messages.parse({
      model,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(ReadSchema) },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Now: ${clock(now)} (${tz}).\n\n<chat>\n${transcript}\n</chat>`,
      }],
    })
    if (response.stop_reason !== 'end_turn') return null
    return response.parsed_output ?? null
  }
}
