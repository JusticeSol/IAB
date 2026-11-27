# IAB (In a bit)

Meetups you agree in Telegram show up on your Even G2, and you answer with one tap: "I'll be there", "10 min late", "I'm here", or the choice your friend asked for ("Outside lobby" / "Indoor arena").

Built for the people you actually meet: the gym group that texts "leg day by 5, outside lobby or indoor arena?" while your phone is in the locker.

**Tracks:** 01 Messaging & News (main) and 04 AI Assistants & Work (Telegram + Claude + Google Calendar in one flow). Also entered for Best Telegram integration.

Nothing in this repo existed before Nov 23, 2026. It uses the Even Hub SDK, the Anthropic SDK, chrono-node and Vite.

## What it does

1. **A friend proposes.** "leg day by 5pm. outside lobby or indoor arena?" becomes a card on the glasses: `TUNDE asks · Leg day?` with `Outside lobby / Indoor arena / Can't make it`.
2. **You tap an answer.** It is sent from your own Telegram account (not a bot), and the card becomes the agreed plan.
3. **Your calendar is checked.** If something overlaps, the card says `! Clash: Standup 17:30`. One tap adds the meetup to Google Calendar.
4. **On the day.** `I'll be there`, `10 min late` (moves the plan by 10 minutes) and `I'm here` (closes it).

Your friends install nothing. IAB works in any private Telegram chat you choose to share with it.

## How it works

```
Telegram (Secretary Mode) ──► IAB server (Node, Railway) ──► Claude Haiku: reads the chat
                                  │   ▲                        Google Calendar: clash / add
                                  ▼   │
                         Even G2 app (Even Hub SDK WebView): card + one-tap replies
```

- **Telegram:** the bot is connected to your account through Secretary Mode (Settings → Chat Automation), so it sees only the private chats you pick and replies as you.
- **Claude** (`claude-haiku-5-5`, structured output) reads the last few messages of the chat and returns the meetup state: proposed / agreed / cancelled, who proposed it, time, place, activity, and any choice the friend asked for. It understands slang ("bet", "abeg let us shift it") and "at 5" meaning 17:00. If Claude is unavailable, English keyword rules take over. Each message costs about $0.0002.
- **Glasses app:** a 3-line card with up to 4 replies, scrolled and tapped on the touchpad. Retried taps never send twice.

## Privacy and safety

- Only the private chats you select in Telegram reach the server.
- Message text is **never written to disk**. The last 12 messages of a chat, from the last 12 hours, are held in memory to send to Claude. Only the meetup's name, time and place are stored.
- A message goes out only after a tap. If Telegram's 24-hour reply window has closed, IAB does not send and hands the text to your phone instead.
- Google access is `calendar.events` on the primary calendar, used only to check the plan's hour and to add the event you tap.

## Try it

The server runs at `https://iab-production-aba3d365.up.railway.app`, and the glasses app in `iab.ehpk` points to it.

1. In Telegram, go to **Settings → Chat Automation**, add **@Inabit_bot**, choose the chats it may see and allow replies.
2. Send a message in one of those chats (or `/start` to the bot) to get a pairing code. Enter it on the IAB phone page.
3. Optional: send `/calendar` to the bot and sign in with Google. The Google app is in testing mode, so your Gmail address has to be added as a test user first; ask us.

## Run it yourself

```bash
npm install
cp .env.example .env       # bot token, Anthropic API key, optional Google keys
npm run server             # API + Telegram polling on :8787
VITE_API=http://127.0.0.1:8787 npm run dev   # glasses app on :5173
npm run sim                # Even Hub simulator
npm test
```

- Create the bot with @BotFather and turn on **Secretary Mode** (Bot Settings).
- **Google Calendar:** create an OAuth "Web application" client and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL`. The redirect URI is `PUBLIC_URL/google/callback`.
- **Without a bot token:** `dev/fake-telegram.js` stands in for Telegram on port 8788. Start the server with `TELEGRAM_BOT_TOKEN=fake TELEGRAM_API=http://127.0.0.1:8788`.
- **Card layout without a server:** set `PREVIEW` in `app/src/main.ts` to `'agreed'` or `'proposal'` (development builds only).
- **Claude reader on sample chats:** `node --env-file=.env dev/try-reader.js`.
- On Windows, the simulator crashes when the project path is very long. Use a short folder.

**Deploy:** `railway.json` runs the server on Railway with a volume at `/data` (`DB_PATH=/data/iab.db`). Only one copy may poll a bot at a time.

**Package:** `npm run pack` builds the app and writes `iab.ehpk`. Network access is limited to the server in `app.json`.

## Limits today

- One open plan per chat.
- Private chats only: group chats would need the bot added to the group.
- Times are read in the user's time zone, set when pairing.
