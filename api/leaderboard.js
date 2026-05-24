import { kv } from "@vercel/kv";

/**
 * Leaderboard API
 *
 * Modes:
 *   - death       (board = timer-seconds string e.g. "5")     higher score wins
 *   - timeattack  (board = "region|difficulty|choices")       lower score (ms) wins
 *   - ranked      (board = "global")                          higher rating wins
 *   - daily       (board = YYYY-MM-DD)                        lower total ms wins
 *
 * Storage:
 *   - Sorted set     lb:<mode>:<board>    score -> username (unique per user, best-of via GT/LT semantics)
 *   - Hash           lb-meta:<mode>:<board>   username -> JSON meta blob
 */

const HIGHER_BETTER = new Set(["death", "ranked"]);
const VALID_MODES = new Set(["death", "timeattack", "ranked", "daily"]);

function cleanUsername(s) {
  if (typeof s !== "string") return null;
  const cleaned = s.trim().replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 20);
  if (cleaned.length < 2) return null;
  return cleaned;
}
function cleanBoard(s) {
  if (typeof s !== "string") return "global";
  return s.replace(/[^A-Za-z0-9_\-|.:]/g, "").slice(0, 64) || "global";
}

function entriesFromZRange(arr) {
  // @vercel/kv zrange with withScores returns alternating [member, score, ...]
  // depending on the SDK version it may return [{member, score}] objects too.
  if (!arr || !arr.length) return [];
  if (typeof arr[0] === "object" && arr[0] !== null && "member" in arr[0]) {
    return arr.map(o => ({ username: String(o.member), score: Number(o.score) }));
  }
  const out = [];
  for (let i = 0; i < arr.length; i += 2) {
    out.push({ username: String(arr[i]), score: Number(arr[i + 1]) });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const mode = String(req.query.mode || "");
      const board = cleanBoard(String(req.query.board || "global"));
      const limit = Math.max(1, Math.min(parseInt(req.query.limit || "50", 10) || 50, 200));
      if (!VALID_MODES.has(mode)) return res.status(400).json({ error: "Invalid mode" });

      const key = `lb:${mode}:${board}`;
      const metaKey = `lb-meta:${mode}:${board}`;
      const higher = HIGHER_BETTER.has(mode);
      const raw = await kv.zrange(key, 0, limit - 1, { rev: higher, withScores: true });
      const entries = entriesFromZRange(raw);

      let metas = [];
      if (entries.length) {
        metas = await kv.hmget(metaKey, ...entries.map(e => e.username)) || [];
      }
      const out = entries.map((e, i) => {
        let meta = null;
        try {
          const raw = metas[i];
          if (raw) meta = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {}
        return { rank: i + 1, username: e.username, score: e.score, meta };
      });
      return res.status(200).json({ entries: out });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const mode = String(body.mode || "");
      const board = cleanBoard(String(body.board || "global"));
      const username = cleanUsername(body.username);
      const score = Number(body.score);
      const meta = (body.meta && typeof body.meta === "object") ? body.meta : {};

      if (!VALID_MODES.has(mode)) return res.status(400).json({ error: "Invalid mode" });
      if (!username) return res.status(400).json({ error: "Invalid username (2-20 alphanumeric, _ or -)" });
      if (!Number.isFinite(score)) return res.status(400).json({ error: "Invalid score" });

      const key = `lb:${mode}:${board}`;
      const metaKey = `lb-meta:${mode}:${board}`;
      const higher = HIGHER_BETTER.has(mode);

      // Sanity caps — not anti-cheat, just prevent absurd values
      if (mode === "timeattack" || mode === "daily") {
        if (score < 100 || score > 1000 * 60 * 90) return res.status(400).json({ error: "Implausible time" });
      }
      if (mode === "death" && (score < 0 || score > 1000)) return res.status(400).json({ error: "Implausible streak" });
      if (mode === "ranked" && (score < 0 || score > 1000)) return res.status(400).json({ error: "Implausible rating" });

      const existing = await kv.zscore(key, username);
      const isBetter = existing == null || (higher ? score > existing : score < existing);
      if (isBetter) {
        await kv.zadd(key, { score, member: username });
        await kv.hset(metaKey, { [username]: JSON.stringify({ ...meta, date: Date.now() }) });
      }

      const rankIndex = higher
        ? await kv.zrevrank(key, username)
        : await kv.zrank(key, username);
      const total = await kv.zcard(key);
      return res.status(200).json({
        accepted: isBetter,
        rank: rankIndex != null ? rankIndex + 1 : null,
        total: total || 0,
        previousBest: existing
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: String(e && e.message || e) });
  }
}
