import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty, OsEventTypeList,
  RebuildPageContainer, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const API: string = import.meta.env.VITE_API ?? 'http://127.0.0.1:8787'
type Action = { id: string; label: string }
type Plan = {
  id: number; name: string; at: number; place: string | null
  activity: string | null; state: 'proposed' | 'agreed'; actions: Action[]
}
type Result = { status: string; text?: string; username?: string | null }

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
      xPosition: 16, yPosition: 12, width: 544, height: withActions ? 124 : 264,
      isEventCapture: withActions ? 0 : 1,
    })],
    listObject: withActions ? [new ListContainerProperty({
      containerID: 2, containerName: 'actions', isEventCapture: 1,
      xPosition: 16, yPosition: 144, width: 544, height: 136,
      itemContainer: new ListItemContainerProperty({ itemCount: plan?.actions.length ?? 0, itemWidth: 0, isItemSelectBorderEn: 1, itemName: plan?.actions.map((a) => a.label) ?? [] }),
    })] : [],
  }
  if (started) await bridge.rebuildPageContainer(new RebuildPageContainer(page))
  else {
    started = true
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
  }
}

function card(p: Plan) {
  const mins = Math.round((p.at - Date.now()) / 60_000)
  const eta = mins >= 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : mins > 0 ? `in ${mins} min` : mins === 0 ? 'now' : `${-mins} min ago`
  const time = new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const what = p.activity ? ` · ${p.activity}` : ''
  // A proposal is a question waiting on me; an agreed plan is a fact.
  const head = p.state === 'proposed' ? `${p.name.toUpperCase()} asks${what || ' to meet'}?` : `${p.name.toUpperCase()}${what}`
  return `${head}\n${time}  ${eta}${p.place ? `\n${p.place}` : ''}`
}

async function unpair() {
  token = ''
  await bridge.setLocalStorage('token', '')
  $('pair').hidden = false
  await draw('Pair IAB on your phone', false)
}

async function refresh() {
  if (busy) return
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
    await draw(`Sending to ${target.name}…`, false)
    const r = await api<Result>(`/plans/${target.id}/act`, { action: action.id, op: pending.op })
    pending = null
    if (r.status === 'sent') await draw(`Sent to ${target.name}\n"${r.text}"`, false)
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
