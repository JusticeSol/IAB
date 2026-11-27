import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty, OsEventTypeList,
  RebuildPageContainer, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

// The hosted server; set VITE_API=http://127.0.0.1:8787 to develop against a local one.
const API: string = import.meta.env.VITE_API ?? 'https://iab-production-aba3d365.up.railway.app'
type Action = { id: string; label: string }
type Plan = {
  id: number; name: string; at: number; place: string | null
  activity: string | null; state: 'proposed' | 'agreed'; actions: Action[]
  clash: { summary: string; start: number } | null
  going?: boolean
}
type Result = { status: string; text?: string; username?: string | null }

// Layout preview in development only: set to 'agreed' or 'proposal' to draw a sample card without the server.
const PREVIEW: '' | 'agreed' | 'proposal' = ''
const sample = (): Plan | null => {
  if (!import.meta.env.DEV || !PREVIEW) return null
  const at = Date.now() + 2 * 3600_000 + 15 * 60_000
  return PREVIEW === 'agreed'
    ? { id: 1, name: 'Jerpi', at, place: 'Cafe One, Lekki Phase 1', activity: 'Leg day', state: 'agreed',
        clash: { summary: 'Weekly team standup', start: at + 30 * 60_000 },
        actions: [{ id: 'onway', label: 'On my way' }, { id: 'late', label: '10 min late' }, { id: 'here', label: "I'm here" }, { id: 'cal', label: 'Add to calendar' }] }
    : { id: 2, name: 'Tunde', at, place: null, activity: 'Leg day', state: 'proposed', clash: null,
        actions: [{ id: 'opt0', label: 'Outside lobby' }, { id: 'opt1', label: 'Indoor arena' }, { id: 'cant', label: "Can't make it" }] }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const bridge = await waitForEvenAppBridge()

let token = (await bridge.getLocalStorage('token')) || ''
let plan: Plan | null = null
let busy = false
let shown = ''
let layout: boolean | null = null
let layoutKey = ''
let started = false
// Reused until the outcome is known, so a retry cannot send twice.
let pending: { key: string; op: string } | null = null

class Unauthorized extends Error {}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const data = await res.json()
  if (res.status === 401 && path !== '/pair') throw new Unauthorized()
  if (!res.ok) throw new Error(data.error)
  return data
}

/** Draw one headline, plus the replies when there is a plan to act on. */
async function draw(text: string, withActions: boolean) {
  const key = `${withActions}|${text}`
  if (key === shown) return
  shown = key
  $('status').textContent = text
  // Same plan and same replies: update text in place, since a rebuild moves the selection back to row one mid-choice.
  const listKey = withActions && plan ? `${plan.id}|${plan.actions.map((a) => a.id).join()}` : ''
  const samePlan = !withActions || layoutKey === listKey
  if (layout === withActions && samePlan) {
    await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'card', content: text }))
    return
  }
  layout = withActions
  layoutKey = listKey
  const page = {
    containerTotalNum: withActions ? 2 : 1,
    textObject: [new TextContainerProperty({
      containerID: 1, containerName: 'card', content: text,
      xPosition: 16, yPosition: 8, width: 544, height: withActions ? 90 : 264,
      isEventCapture: withActions ? 0 : 1,
    })],
    listObject: withActions ? [new ListContainerProperty({
      containerID: 2, containerName: 'actions', isEventCapture: 1,
      xPosition: 16, yPosition: 100, width: 544, height: 184,
      itemContainer: new ListItemContainerProperty({ itemCount: plan?.actions.length ?? 0, itemWidth: 0, isItemSelectBorderEn: 1, itemName: plan?.actions.map((a) => a.label) ?? [] }),
    })] : [],
  }
  if (!started) {
    started = true
    // After a reload the host may still hold the old page and ignore this call, so a rebuild always follows.
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
  }
  await bridge.rebuildPageContainer(new RebuildPageContainer(page))
}

function card(p: Plan) {
  const mins = Math.round((p.at - Date.now()) / 60_000)
  const eta = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : mins > 0 ? `in ${mins} min` : mins === 0 ? 'now' : `${-mins} min ago`
  const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const what = p.activity ? ` · ${p.activity}` : ''
  // A proposal is a question waiting on me; an agreed plan is a fact.
  const head = p.state === 'proposed' ? `${p.name.toUpperCase()} asks${what || ' to meet'}?` : `${p.name.toUpperCase()}${what}${p.going ? ' · On the way' : ''}`
  // Three lines at most, so four replies fit below without scrolling.
  const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n).trimEnd() + '.' : t)
  const where = p.place ? `  ·  ${clip(p.place, 20)}` : ''
  const clash = p.clash ? `\n! Clash: ${clip(p.clash.summary, 20)} ${hhmm(p.clash.start)}` : ''
  return `${clip(head, 34)}\n${hhmm(p.at)}  ${eta}${where}${clash}`
}

async function unpair() {
  token = ''
  await bridge.setLocalStorage('token', '')
  $('pair').hidden = false
  await draw('Pair IAB on your phone', false)
}

async function refresh() {
  if (busy) return
  const demo = sample()
  if (demo) {
    plan = demo
    return draw(card(plan), true)
  }
  if (!token) return unpair()
  try {
    const { plan: latest } = await api<{ plan: Plan | null }>('/next')
    if (busy) return
    plan = latest
    await draw(plan ? card(plan) : 'Nobody is waiting.\nAgree a time in Telegram\nand it shows up here.', !!plan)
  } catch (e) {
    if (e instanceof Unauthorized) return unpair()
    plan = null
    await draw('Offline. Tap to retry.', false)
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function act(index: number) {
  const action = plan?.actions[index]
  if (!plan || !action || busy) return
  busy = true
  const target = plan
  const key = `${target.id}:${action.id}`
  if (pending?.key !== key) pending = { key, op: `${Date.now()}-${Math.random().toString(36).slice(2)}` }
  $('handoff').hidden = true
  try {
    await draw(action.id === 'cal' ? 'Adding to calendar…' : `Sending to ${target.name}…`, false)
    const r = sample()
      ? { status: action.id === 'cal' ? 'added' : 'sent', text: action.label }
      : await api<Result>(`/plans/${target.id}/act`, { action: action.id, op: pending.op })
    pending = null
    if (r.status === 'sent') await draw(`Sent to ${target.name}\n"${r.text}"`, false)
    else if (r.status === 'added') await draw('Added to Google Calendar', false)
    else if (r.status === 'failed') await draw('Calendar did not respond.\nNothing added.', false)
    else if (r.status === 'handoff') {
      $('text').textContent = r.text ?? ''
      const link = $<HTMLAnchorElement>('open')
      link.hidden = !r.username
      if (r.username) link.href = `https://t.me/${r.username}?text=${encodeURIComponent(r.text ?? '')}`
      $('handoff').hidden = false
      await draw('NOT SENT\nFinish on your phone.', false)
    } else if (r.status === 'unknown') await draw('May not have sent.\nCheck Telegram.', false)
    else await draw('Plan changed. Nothing sent.', false)
  } catch {
    // The request may have reached the server; keep the op so the next tap is safe.
    await draw('No connection.\nTap again to retry safely.', false)
  }
  await pause(2500)
  busy = false
  await refresh()
}

bridge.onEvenHubEvent((event) => {
  const e = event.listEvent ?? event.textEvent ?? event.sysEvent
  // Zero values are dropped in transit: a missing type is a click, a missing index is the first row.
  const type = e?.eventType ?? (event.listEvent || event.textEvent || (event.sysEvent && !event.sysEvent.imuData) ? OsEventTypeList.CLICK_EVENT : undefined)
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void bridge.shutDownPageContainer(1)
  else if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) void refresh()
  else if (type === OsEventTypeList.CLICK_EVENT) {
    if (event.listEvent) void act(event.listEvent.currentSelectItemIndex ?? 0)
    else if (!plan) void refresh()
  }
})

async function pairWith(code: string) {
  try {
    const r = await api<{ token: string }>('/pair', { code, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
    token = r.token
    await bridge.setLocalStorage('token', token)
    $('pair').hidden = true
    await refresh()
  } catch (e) {
    $('status').textContent = e instanceof Error ? e.message : 'Pairing failed'
  }
}

$('pair').addEventListener('submit', (ev) => {
  ev.preventDefault()
  void pairWith($<HTMLInputElement>('code').value.trim())
})

$('copy').addEventListener('click', () => void navigator.clipboard.writeText($('text').textContent ?? ''))

// Local development only: http://127.0.0.1:5173/?code=12345678
const devCode = import.meta.env.DEV && new URLSearchParams(location.search).get('code')
if (devCode) await pairWith(devCode)
await refresh()
setInterval(() => void refresh(), 15_000)
