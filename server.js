import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.use(morgan("combined"));

const PORT = Number(process.env.PORT || 3000);
const HENRIK_API_KEY = (process.env.HENRIK_API_KEY || "").trim();

const DEFAULT_REGION = (process.env.DEFAULT_REGION || "ap").trim();
const DEFAULT_NAME = (process.env.DEFAULT_NAME || "").trim();
const DEFAULT_TAG = (process.env.DEFAULT_TAG || "").trim();

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 30);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 0);

// Nightbot urlfetch 限制：body 純文字且 < 400 字；我們保守抓更小
const MAX_TEXT_LEN = 350;

// --- Simple in-memory cache ---
/**
 * cacheKey -> { expiresAt: number, value: string }
 */
const cache = new Map();

/**
 * ip -> lastHitMs
 */
const ipLastHit = new Map();

function nowMs() {
  return Date.now();
}

function clampText(text) {
  const s = String(text ?? "");
  if (s.length <= MAX_TEXT_LEN) return s;
  return s.slice(0, MAX_TEXT_LEN - 1) + "…";
}

function normalizeRegion(region) {
  const r = String(region || "").toLowerCase().trim();
  const allowed = new Set(["ap", "br", "eu", "kr", "latam", "na"]);
  if (!allowed.has(r)) return null;
  return r;
}

function normalizeRiotIdPart(s, maxLen) {
  const v = String(s || "").trim();
  if (!v) return null;
  if (v.length > maxLen) return v.slice(0, maxLen);
  return v;
}

function buildCacheKey(region, name, tag) {
  return `${region}::${name}#${tag}`;
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  cache.set(key, {
    expiresAt: nowMs() + CACHE_TTL_SECONDS * 1000,
    value
  });
}

async function fetchHenrikMMR(region, name, tag) {
  if (!HENRIK_API_KEY) {
    return { ok: false, text: "伺服器未設定 API Key（HENRIK_API_KEY）" };
  }

  const url =
    `https://api.henrikdev.xyz/valorant/v2/mmr/` +
    `${encodeURIComponent(region)}/` +
    `${encodeURIComponent(name)}/` +
    `${encodeURIComponent(tag)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: HENRIK_API_KEY
      }
    });
  } catch {
    return { ok: false, text: "上游 API 連線失敗" };
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, text: "上游回傳非 JSON" };
  }

  if (!resp.ok) {
    const msg = data?.errors?.[0]?.message || data?.message || `HTTP ${resp.status}`;
    return { ok: false, text: `上游錯誤：${msg}` };
  }

  // 相容兩種格式：
  // - 新格式：data.current_data
  // - 舊格式：data
  const payload = data?.data ?? null;
  const mmr = payload?.current_data ?? payload ?? null;

  if (!mmr) return { ok: false, text: "找不到牌位資料" };

  const tier = mmr.currenttierpatched || "Unknown";
  const rr = mmr.ranking_in_tier ?? null;
  const elo = mmr.elo ?? null;

  const riotIdStr = `${name}#${tag}`;
  const parts = [
    `${riotIdStr}｜${tier}`,
    rr !== null ? `RR ${rr}` : null,
    elo !== null ? `Elo ${elo}` : null
  ].filter(Boolean);

  return { ok: true, text: parts.join("｜") };
}

// --- Routes ---
app.get("/", (req, res) => {
  res.type("text/plain; charset=utf-8").send("OK");
});

app.get("/rank_debug", async (req, res) => {
  const region = normalizeRegion(req.query.region ?? DEFAULT_REGION);
  const name = normalizeRiotIdPart(req.query.name ?? DEFAULT_NAME, 32);
  const tag = normalizeRiotIdPart(req.query.tag ?? DEFAULT_TAG, 8);

  if (!region || !name || !tag) {
    res.status(400).json({ error: "bad params" });
    return;
  }

  if (!HENRIK_API_KEY) {
    res.status(500).json({ error: "missing HENRIK_API_KEY" });
    return;
  }

  const url =
    `https://api.henrikdev.xyz/valorant/v2/mmr/` +
    `${encodeURIComponent(region)}/` +
    `${encodeURIComponent(name)}/` +
    `${encodeURIComponent(tag)}`;

  const upstream = await fetch(url, {
    headers: { Authorization: HENRIK_API_KEY }
  });

  const data = await upstream.json().catch(() => ({}));
  res.status(upstream.status).json(data);
});

app.get("/rank", async (req, res) => {
  // 基本防刷：同 IP 最低間隔
  if (MIN_INTERVAL_MS > 0) {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const last = ipLastHit.get(ip) || 0;
    const t = nowMs();
    if (t - last < MIN_INTERVAL_MS) {
      res.type("text/plain; charset=utf-8").status(429).send("請稍後再試（太頻繁）");
      return;
    }
    ipLastHit.set(ip, t);
  }

  const region = normalizeRegion(req.query.region ?? DEFAULT_REGION);
  const name = normalizeRiotIdPart(req.query.name ?? DEFAULT_NAME, 32);
  const tag = normalizeRiotIdPart(req.query.tag ?? DEFAULT_TAG, 8);

  if (!region) {
    res.type("text/plain; charset=utf-8").status(400).send("region 需為 ap/eu/na/kr/latam/br");
    return;
  }
  if (!name || !tag) {
    res
      .type("text/plain; charset=utf-8")
      .status(400)
      .send("缺少 name 或 tag（例：/rank?region=ap&name=AAA&tag=1234）");
    return;
  }

  const cacheKey = buildCacheKey(region, name, tag);
  const cached = getFromCache(cacheKey);
  if (cached) {
    res.type("text/plain; charset=utf-8").send(clampText(cached));
    return;
  }

  const result = await fetchHenrikMMR(region, name, tag);
  const out = clampText(result.text);

  if (!result.ok) {
    setCache(cacheKey, out);
    res.type("text/plain; charset=utf-8").status(502).send(out);
    return;
  }

  setCache(cacheKey, out);
  res.type("text/plain; charset=utf-8").send(out);
});

app.listen(PORT, () => {
  console.log(`🟢 API listening on http://127.0.0.1:${PORT}`);
});
