# Texas Hold'Ex

A real-time multiplayer market-making trading game built on Texas Hold'em.

## How to play

1. One player creates a room and shares the 5-letter room code
2. Others join using the code
3. The host deals cards
4. All players blindly bid a spread `k` — lowest bidder becomes the **market maker** and earns `k` pts per trade (ties broken randomly)
5. The market maker posts 3 markets (no flop → 3-card flop → full board), and all other players go long or short each time
6. After all 3 instances, PnL is settled and the leaderboard updates

## Local development

```bash
npm install
npm run dev       # uses nodemon for auto-reload
# open http://localhost:3000 in multiple tabs to test multiplayer
```

## Deploying to Railway (recommended for real-time apps)

Vercel runs on serverless functions which do not support persistent WebSocket connections — Socket.io requires a long-lived server process. **Railway** is the easiest free alternative.

### Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo** and select this repo
4. Railway auto-detects Node.js and runs `npm start`
5. Click **Settings → Networking → Generate Domain** to get a public URL
6. Share that URL with your friends — done!

### Environment variables (Railway)

None required. The server uses `process.env.PORT` automatically (Railway injects this).

---

## Why not Vercel?

Vercel's serverless functions are stateless and terminate after each request, so in-memory room state and persistent WebSocket connections are not supported. If you want to use Vercel anyway, you would need to:

- Replace in-memory `rooms` with a Redis/Upstash store
- Replace Socket.io with Pusher or Ably (managed WebSocket services)

For a weekend project, Railway or Render are much simpler.

## Tech stack

- **Node.js + Express** — HTTP server + static file serving
- **Socket.io** — real-time bidirectional events
- Vanilla JS frontend (no build step needed)
