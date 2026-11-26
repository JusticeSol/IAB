# IAB (In a bit)

Agree to meet someone in Telegram, then answer with one tap on Even G2: "On my way", "10 min late", "I'm here", or the choice your friend asked for ("Outside lobby" / "Indoor arena").

Track: Messaging & News. Also entered for Best Telegram integration. Nothing in this repo existed before Nov 23, 2026; it uses the Even Hub SDK, the Anthropic SDK (Claude reads plans from the chat), chrono-node and Vite.

## Run

1. Create a bot with @BotFather and turn on Secretary Mode (Bot Settings → Secretary Mode).
2. Copy `.env.example` to `.env`, paste the bot token and an Anthropic API key.
3. `npm install`, then in three terminals: `npm run server`, `npm run dev`, `npm run sim`.
4. Connect the bot to your Telegram account in Telegram settings (Chat Automation). Choose which chats it may see and allow replies.
5. Enter the code the bot sends you on the IAB phone page.

On Windows, the simulator crashes when the project path is very long. Use a short folder.

## Without a bot token

`dev/fake-telegram.js` stands in for Telegram on port 8788. Start the server with `TELEGRAM_BOT_TOKEN=fake TELEGRAM_API=http://127.0.0.1:8788`.

## Safety

- Only private chats the user selects in Telegram reach the server. Message text is never written to disk; names, times and places of meetups are.
- To read plans, the last few messages of a chat (up to 12, from the last 12 hours) are kept in memory and sent to the Claude API. Without an API key nothing leaves the server.
- A message goes out only after a tap. Retried taps are sent once.
- Telegram lets a connected bot reply only in chats with an incoming message in the last 24 hours. Otherwise IAB hands the text to the phone.

## How plans are read

Claude reads the recent chat and returns the meetup state (proposed / agreed / cancelled, who proposed it, time, place, activity) and any choice the friend asked for. Those choices become one-tap replies. If Claude is unavailable, English keyword rules take over. `node --env-file=.env dev/try-reader.js` runs the reader on sample chats.

## Limits today

One open plan per chat. Private chats only: group chats need the bot added to the group.
