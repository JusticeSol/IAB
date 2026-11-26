# IAB (In a bit)

Agree to meet someone in Telegram, then tell them "On my way", "10 min late" or "I'm here" with one tap on Even G2.

Track: Messaging & News. Also entered for Best Telegram integration. Nothing in this repo existed before Nov 23, 2026; it uses the Even Hub SDK, chrono-node and Vite.

## Run

1. Create a bot with @BotFather and enable its business/automation mode there.
2. Copy `.env.example` to `.env` and paste the token.
3. `npm install`, then in three terminals: `npm run server`, `npm run dev`, `npm run sim`.
4. Connect the bot to your Telegram account in Telegram settings. Choose which chats it may see and allow replies.
5. Enter the code the bot sends you on the IAB phone page.

On Windows, the simulator crashes when the project path is very long. Use a short folder.

## Without a bot token

`dev/fake-telegram.js` stands in for Telegram on port 8788. Start the server with `TELEGRAM_BOT_TOKEN=fake TELEGRAM_API=http://127.0.0.1:8788`.

## Safety

- Only private chats the user selects in Telegram reach the server. Message text is not stored; names, times and places of meetups are.
- A message goes out only after a tap. Retried taps are sent once.
- Telegram lets a connected bot reply only in chats with an incoming message in the last 24 hours. Otherwise IAB hands the text to the phone.

## Limits today

Meetups are found with English time and keyword rules, one open plan per chat.
