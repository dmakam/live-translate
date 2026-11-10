# Live Translate - Hindi to English, live (proof of concept)

Anyone plays a Hindi stream (YouTube, Zoom in the browser, a live event feed) in Chrome, and gets
English subtitles plus read-aloud. There are two modes:

- **Organise an event** (`/host`): create the link days ahead (optional custom name like `/r/SATSANG`
  and start time), share it, then on the day one laptop captures the stream's audio. Listeners open the
  link on any phone, see a "starts soon" countdown, and the English appears by itself when it goes live.
  The organiser link (`/host?room=...&key=...`) reopens the event on any computer.
- **Solo** (`/solo`): one person translates a tab on their own screen, with floating captions.

The test guide is at `/test`.

## How it works

| Step | What does it | Cost |
|---|---|---|
| Tab audio capture | Chrome screen-share with "Also share tab audio" | free |
| Hindi speech to text | Chrome Web Speech API (hi-IN), fed the tab's audio track | free |
| Hindi to English | Claude Haiku via the server if `ANTHROPIC_API_KEY` is set; otherwise Chrome's on-device translator | small, per use |
| Delivery to listeners | WebSocket rooms on this server | free |
| English audio | Each listener's phone reads the lines aloud (speechSynthesis) | free |

A line is translated only once Chrome marks it final, which happens at a natural pause. Hindi puts
the verb last, so this stops subtitles from rearranging mid-sentence. Translations are queued, so
lines always appear in the order they were spoken.

## Run locally

    npm install
    node server.js                                   # Chrome translator only
    ANTHROPIC_API_KEY=sk-ant-... node server.js      # Claude translation

Open http://localhost:3000. Screen capture needs `localhost` or https.

## Deploy to the VPS (Docker behind the shared Caddy)

1. Add a DNS A record **translate** -> 50.6.226.244 (Bluehost DNS for dhirajmakam.com).
2. Create an empty private GitHub repo `dmakam/live-translate` and push this folder to it.
3. On the server:

       cd ~ && git clone git@github.com:dmakam/live-translate.git && cd live-translate
       bash deploy.sh                # creates .env from .env.example on first run
       nano .env                     # optional: add ANTHROPIC_API_KEY, then run deploy.sh again

`deploy.sh` checks the running containers, finds the Caddy network, builds and starts the
`live-translate` container, copies `caddy/translate.caddy` into `/home/deploy/caddy-sites/`, then
validates and reloads Caddy. It never edits the shared Caddyfile. The container is capped at 160 MB of memory.

## Guardrails (set in .env)

- `MAX_ROOMS` (100): the most event links that can exist at once
- `ROOM_HOURS` (4): an event link closes this long after its start time or its last activity
- `ADVANCE_DAYS` (14): how far ahead a link can be created
- `TRANSLATE_PER_MIN` (40): the most Claude translations per IP per minute
- `DAILY_TRANSLATIONS` (5000): the most Claude calls per day across the whole site. After that, pages fall back to Chrome's translator.

## Known limits

- Capturing audio needs **desktop Chrome** with a recent version. Listeners can use any browser.
- Recognition quality depends on clean audio. A sound-desk feed works much better than a room mic.
- Zoom must be joined in the browser, so that it is a tab Chrome can share.
- Chrome's speech recognition runs on Google's servers, so the host needs to be online.
- Event links are saved in a Docker volume and survive restarts; the transcript of a live event does not.
