/** Telegram answered and refused, so nothing was sent. */
export class TelegramError extends Error {}

export function telegram(token, base = 'https://api.telegram.org') {
  return async function call(method, body = {}, timeoutMs = 15_000) {
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
}
