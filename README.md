# Flagmaster

Learn every flag in the world. Multiple modes, ranked tier system, global leaderboards.

## Modes

- **Multiple Choice** — pick the country from 4-5 options
- **Type the Name** — type the country name (forgiving spelling)
- **Reverse** — given a country name, pick the flag
- **Timed Sprint** — multiple choice with 8s per flag, speed bonus
- **Flashcards** — browse and study
- **Marathon** — all flags one shot each
- **Death Mode ☠** — sudden death, 3-10s per flag, one mistake ends the run
- **Ranked 🏆** — placement through all 197 flags, get a tier from Iron → Challenger
- **Time Attack ⏱** — race through every flag, per-flag PBs and total best time
- **Daily 📅** — same 25 flags for everyone each day, race for the daily leaderboard

## Global leaderboards

Death Mode (per timer), Time Attack (per pool), Ranked rating, and Daily streak all have
public leaderboards powered by Vercel KV (Redis).

## Deploy to Vercel

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create flagmaster --public --source=. --push
```

(or push manually to a new GitHub repo)

### 2. Import to Vercel

1. Go to <https://vercel.com/new>
2. Import the GitHub repo you just pushed
3. Click **Deploy** (no build step needed)

### 3. Add Vercel KV

1. In your Vercel project dashboard, click **Storage** → **Create Database** → **KV**
2. Pick a region near your users
3. Click **Connect** — Vercel will add the `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   environment variables automatically
4. **Redeploy** the project so the API picks up the new env vars

Done. Visit your `*.vercel.app` URL — leaderboards work globally.

## Local development

```bash
npm install
npx vercel dev
```

That gives you the static site + API on `http://localhost:3000`. You'll need to be
signed in to Vercel and have the KV variables linked (run `vercel link` once).

For pure UI development without the leaderboard, just open `index.html` in a browser.
API calls will fail silently and the rest of the game still works.

## Stack

- Vanilla HTML/CSS/JS (no build step)
- Vercel serverless function for `/api/leaderboard`
- Vercel KV (Upstash Redis) sorted sets for the boards
- Flag images from [flagcdn.com](https://flagcdn.com)
