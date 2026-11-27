/** Telegram answered and refused, so nothing was sent. */
export class TelegramError extends Error {}

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

export function telegram(token, base = 'https://api.telegram.org') {
  async function once(method, body, timeoutMs) {
    let data
    try {
      const res = await fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      data = await res.json()
    } catch {
      // Drop the underlying error: it can contain the URL, which holds the token.
      throw new Error(`telegram ${method}: network error`)
    }
    if (!data.ok) throw new TelegramError(`telegram ${method}: ${data.description}`)
    return data.result
  }

  return async function call(method, body = {}, timeoutMs = 15_000) {
    // The bot's own DMs (pairing codes, links) retry on network errors; a duplicate there is harmless.
    // Sends into a friend's chat (business_connection_id) never retry here, so they cannot double-send.
    const tries = method === 'sendMessage' && !body.business_connection_id ? 3 : 1
    for (let i = 1; ; i++) {
      try {
        return await once(method, body, timeoutMs)
      } catch (e) {
        if (e instanceof TelegramError || i >= tries) throw e
        await pause(2000)
      }
    }
  }
}
