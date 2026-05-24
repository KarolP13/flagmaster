import { Redis } from "@upstash/redis";

/**
 * Leaderboard API — powered by Upstash Redis
 *
 * Auto-detects connection from either env var scheme:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash direct)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN (legacy Vercel KV naming)
 *
 * Modes:
 *   - death       (board = timer-seconds string e.g. "5")     higher score wins
 *   - timeattack  (board = "region|difficulty|choices")       lower score (ms) wins
 *   - ranked      (board = "global")                          higher rating wins
 *   - daily       (board = YYYY-MM-DD)                        lower total ms wins
 *
 * Storage:
 *   - Sorted set     lb:<mode>:<board>      score -> username (one entry per user, best-of)
 *   - Hash           lb-meta:<mode>:<board> username -> JSON meta blob
 */

const HIGHER_BETTER = new Set(["death", "ranked"]);
const VALID_MODES = new Set(["death", "timeattack", "ranked", "daily"]);

let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Redis not configured. Connect Upstash Redis (Storage tab) and redeploy.");
  }
  redis = new Redis({ url, token });
  return redis;
}

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

/**
 * Upstash zrange with withScores returns an array of alternating [member, score, ...]
 * (or sometimes objects depending on options). Normalize to a list of {username, score}.
 */
function normalizeZRange(arr) {
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

  let r;
  try { r = getRedis(); }
  catch (e) { return res.status(500).json({ error: "redis_not_configured", detail: String(e.message || e) }); }

  try {
    if (req.method === "GET") {
      const mode = String(req.query.mode || "");
      const board = cleanBoard(String(req.query.board || "global"));
      const limit = Math.max(1, Math.min(parseInt(req.query.limit || "50", 10) || 50, 200));
      if (!VALID_MODES.has(mode)) return res.status(400).json({ error: "Invalid mode" });

      const key = `lb:${mode}:${board}`;
      const metaKey = `lb-meta:${mode}:${board}`;
      const higher = HIGHER_BETTER.has(mode);

      const raw = await r.zrange(key, 0, limit - 1, { rev: higher, withScores: true });
      const entries = normalizeZRange(raw);

      let metas = [];
      if (entries.length) {
        try {
          metas = await r.hmget(metaKey, ...entries.map(e => e.username)) || [];
        } catch (e) {
          // hmget may return an object keyed by field for some SDK versions
          metas = entries.map(() => null);
        }
      }
      const out = entries.map((e, i) => {
        let meta = null;
        try {
          const raw = Array.isArray(metas) ? metas[i] : metas[e.username];
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
      if (!username) return res.status(400).json({ error: "Invalid username (2-20 chars, alphanumeric/_/-)" });
      if (!Number.isFinite(score)) return res.status(400).json({ error: "Invalid score" });

      // Sanity caps
      if ((mode === "timeattack" || mode === "daily") && (score < 100 || score > 1000 * 60 * 90)) {
        return res.status(400).json({ error: "Implausible time" });
      }
      if (mode === "death" && (score < 0 || score > 1000)) {
        return res.status(400).json({ error: "Implausible streak" });
      }
      if (mode === "ranked" && (score < 0 || score > 1000)) {
        return res.status(400).json({ error: "Implausible rating" });
      }

      const key = `lb:${mode}:${board}`;
      const metaKey = `lb-meta:${mode}:${board}`;
      const higher = HIGHER_BETTER.has(mode);

      const existing = await r.zscore(key, username);
      const existingNum = existing == null ? null : Number(existing);
      const isBetter = existingNum == null || (higher ? score > existingNum : score < existingNum);
      if (isBetter) {
        await r.zadd(key, { score, member: username });
        await r.hset(metaKey, { [username]: JSON.stringify({ ...meta, date: Date.now() }) });
      }

      const rankIndex = higher
        ? await r.zrevrank(key, username)
        : await r.zrank(key, username);
      const total = await r.zcard(key);
      return res.status(200).json({
        accepted: isBetter,
        rank: rankIndex != null ? rankIndex + 1 : null,
        total: total || 0,
        previousBest: existingNum
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("Leaderboard API error:", e);
    return res.status(500).json({ error: "server_error", detail: String(e && e.message || e) });
  }
}
