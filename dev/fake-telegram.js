// Stand-in for api.telegram.org, for simulator runs without a bot token.
// POST /push queues an update; GET /sent lists what the bot sent.
import { createServer } from 'node:http'

const queue = []
const sent = []
let id = 1

createServer(async (req, res) => {
  let s = ''
  for await (const c of req) s += c
  const body = s ? JSON.parse(s) : {}
  const end = (d) => res.end(JSON.stringify(d))
  if (req.url === '/push') { queue.push({ update_id: id++, ...body }); return end({ ok: true }) }
  if (req.url === '/sent') return end(sent)
  if (req.url.endsWith('/getUpdates')) {
    const pending = queue.filter((u) => u.update_id >= (body.offset ?? 0))
    if (!pending.length) await new Promise((r) => setTimeout(r, 300))
    return end({ ok: true, result: pending })
  }
  if (req.url.endsWith('/sendMessage')) { sent.push(body); return end({ ok: true, result: {} }) }
  end({ ok: false, description: 'unsupported' })
}).listen(8788)
