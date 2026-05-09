# Reveal — Two-Player Question Game

A real-time two-player web game. Both players answer the same question simultaneously, then reveal at the same time. Levels 1–10 escalate from getting-to-know-you to no-holds-barred.

## Local testing

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows (or two devices on the same network) to test. One creates the room, the other joins with the 4-letter code.

## Push to GitHub

```bash
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin <YOUR_REPO_URL>
git push -u origin main
```

## Expose to the internet (Cloudflare Tunnel — free, no signup)

1. Install `cloudflared`:
   - **Mac:** `brew install cloudflared`
   - **Windows:** download the installer from <https://github.com/cloudflare/cloudflared/releases> (or `winget install --id Cloudflare.cloudflared`)
   - **Linux:** see Cloudflare's docs
2. In one terminal, run the server:
   ```bash
   npm start
   ```
3. In another terminal, start a quick tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
4. Cloudflare prints a public URL like `https://random-words.trycloudflare.com`. Share it with the other player.

Notes:
- Your computer and the tunnel must stay running while you play.
- The URL changes each time you restart the tunnel. For a stable URL, sign up for a free Cloudflare account and use a named tunnel with your own domain.

## Optional: deploy permanently to Glitch

Import the GitHub repo at <https://glitch.com> → "New Project" → "Import from GitHub". Glitch gives you `yourapp.glitch.me` that stays up (sleeps when idle but wakes on request).

## How it works

- Backend: Node + Express + Socket.IO (in-memory room state — nothing persists between sessions)
- Frontend: single-page vanilla JS, no build step
- Questions: `questions.json`, 1000 questions across 10 levels (100 each)

Rooms exist only while at least one player is connected. When everyone leaves, the room is wiped.
