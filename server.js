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
const DEFAULT_PLATFORM = (process.env.DEFAULT_PLATFORM || "pc").trim();
const DEFAULT_NAME = (process.env.DEFAULT_NAME || "").trim();
const DEFAULT_TAG = (process.env.DEFAULT_TAG || "").trim();

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 30);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 0);

// Nightbot urlfetch 限制：body 純文字且 < 400 字；我們保守抓更小
const MAX_TEXT_LEN = 350;

// --- Simple in-memory cache ---
// cacheKey -> { expiresAt: number, value: string }
const cache = new Map();

// ip -> lastHitMs
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

function normalizePlatform(platform) {
  const p = String(platform || "").toLowerCase().trim();
  const allowed = new Set(["pc", "console"]);
  if (!allowed.has(p)) return null;
  return p;
}

function normalizeRiotIdPart(s, maxLen) {
  const v = String(s || "").trim();
  if (!v) return null;
  if (v.length > maxLen) return v.slice(0, maxLen);
  return v;
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

// -------------------- Rank i18n --------------------
function rankToZhTW(tierPatched) {
  const t = String(tierPatched || "").trim();
  if (!t) return "未知";

  // 正規化：多空白、大小寫
  const u = t.replace(/\s+/g, " ").trim().toUpperCase();

  const map = new Map([
    ["UNRATED", "未評級"],
    ["IRON 1", "鐵牌 1"], ["IRON 2", "鐵牌 2"], ["IRON 3", "鐵牌 3"],
    ["BRONZE 1", "青銅 1"], ["BRONZE 2", "青銅 2"], ["BRONZE 3", "青銅 3"],
    ["SILVER 1", "白銀 1"], ["SILVER 2", "白銀 2"], ["SILVER 3", "白銀 3"],
    ["GOLD 1", "黃金 1"], ["GOLD 2", "黃金 2"], ["GOLD 3", "黃金 3"],
    ["PLATINUM 1", "白金 1"], ["PLATINUM 2", "白金 2"], ["PLATINUM 3", "白金 3"],
    ["DIAMOND 1", "鑽石 1"], ["DIAMOND 2", "鑽石 2"], ["DIAMOND 3", "鑽石 3"],
    ["ASCENDANT 1", "超凡入聖 1"], ["ASCENDANT 2", "超凡入聖 2"], ["ASCENDANT 3", "超凡入聖 3"],
    ["IMMORTAL 1", "神話 1"], ["IMMORTAL 2", "神話 2"], ["IMMORTAL 3", "神話 3"],
    ["RADIANT", "輻能aaaa"]
  ]);

  return map.get(u) ?? t;
}

// -------------------- Henrik MMR --------------------
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
      headers: { Authorization: HENRIK_API_KEY }
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

  const payload = data?.data ?? null;
  const mmr = payload?.current_data ?? payload ?? null;

  if (!mmr) return { ok: false, text: "找不到牌位資料" };

  const tierEn = mmr.currenttierpatched || "Unknown";
  const tier = rankToZhTW(tierEn);
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

// -------------------- Record helpers --------------------
const recordState = {
  startedAtMs: null,
  region: null,
  platform: null,
  name: null,
  tag: null
};

let recordCache = { key: "", expiresAt: 0, text: "" };

function fmtTimeTaipei(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(d);

  const get = (t) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

function getMatchGameStartMs(match) {
  const sec = match?.metadata?.game_start;
  if (typeof sec === "number" && Number.isFinite(sec)) return sec * 1000;
  return null;
}

function findPlayerTeam(match, name, tag) {
  const all = match?.players?.all_players;
  if (!Array.isArray(all)) return null;

  const p = all.find(x =>
    String(x?.name ?? "").toLowerCase() === String(name).toLowerCase() &&
    String(x?.tag ?? "").toLowerCase() === String(tag).toLowerCase()
  );

  return p?.team ?? null; // "Red" / "Blue"
}

function didPlayerWin(match, playerTeam) {
  const teams = match?.teams;
  if (!teams || !playerTeam) return null;

  if (String(playerTeam).toLowerCase() === "red") return teams?.red?.has_won ?? null;
  if (String(playerTeam).toLowerCase() === "blue") return teams?.blue?.has_won ?? null;
  return null;
}

async function fetchHenrikMatchesSince(region, platform, name, tag, startedAtMs, mode = "competitive") {
  if (!HENRIK_API_KEY) return { ok: false, text: "伺服器未設定 API Key（HENRIK_API_KEY）" };

  const SIZE = 10;               // v4 size max 10
  const MAX_PAGES = 6;          // 最多 30 頁 = 300 場
  const MAX_TOTAL_MATCHES = 60; // 再多就截斷避免刷爆
  const matches = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * SIZE;

    const url =
      `https://api.henrikdev.xyz/valorant/v4/matches/` +
      `${encodeURIComponent(region)}/` +
      `${encodeURIComponent(platform)}/` +
      `${encodeURIComponent(name)}/` +
      `${encodeURIComponent(tag)}` +
      `?mode=${encodeURIComponent(mode)}` +
      `&size=${SIZE}` +
      `&start=${start}`;

    let resp;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: HENRIK_API_KEY }
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

    const pageMatches = Array.isArray(data?.data) ? data.data : [];
    if (pageMatches.length === 0) break;

    // 只收 startTime 之後開始的對局
    for (const m of pageMatches) {
      const ms = getMatchGameStartMs(m);
      if (ms !== null && ms >= startedAtMs) matches.push(m);
    }

    if (matches.length >= MAX_TOTAL_MATCHES) break;

    // 如果本頁最舊那場都早於 startedAtMs，就可以停止翻頁
    let oldestMs = null;
    for (const m of pageMatches) {
      const ms = getMatchGameStartMs(m);
      if (ms === null) continue;
      oldestMs = (oldestMs === null) ? ms : Math.min(oldestMs, ms);
    }
    if (oldestMs !== null && oldestMs < startedAtMs) break;
  }

  return { ok: true, matches };
}

// -------------------- Routes --------------------
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
  // 防刷（同 IP 最低間隔）
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
    res.type("text/plain; charset=utf-8")
      .status(400)
      .send("缺少 name 或 tag（例：/rank?region=ap&name=AAA&tag=1234）");
    return;
  }

  const cacheKey = `rank::${region}::${name}#${tag}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    res.type("text/plain; charset=utf-8").send(clampText(cached));
    return;
  }

  const result = await fetchHenrikMMR(region, name, tag);
  const out = clampText(result.text);

  // 錯誤也快取短一點避免雪崩（同 TTL）
  setCache(cacheKey, out);

  if (!result.ok) {
    res.type("text/plain; charset=utf-8").status(502).send(out);
    return;
  }

  res.type("text/plain; charset=utf-8").send(out);
});

app.get("/record", async (req, res) => {
  const action = String(req.query.action ?? "").toLowerCase().trim();

  const region = normalizeRegion(req.query.region ?? DEFAULT_REGION);
  const platform = normalizePlatform(req.query.platform ?? DEFAULT_PLATFORM);
  const name = normalizeRiotIdPart(req.query.name ?? DEFAULT_NAME, 32);
  const tag = normalizeRiotIdPart(req.query.tag ?? DEFAULT_TAG, 8);

  if (!region) {
    res.type("text/plain; charset=utf-8").status(400).send("region 需為 ap/eu/na/kr/latam/br");
    return;
  }
  if (!platform) {
    res.type("text/plain; charset=utf-8").status(400).send("platform 需為 pc 或 console");
    return;
  }
  if (!name || !tag) {
    res.type("text/plain; charset=utf-8")
      .status(400)
      .send("缺少 name 或 tag（例：/record?region=ap&platform=pc&name=AAA&tag=1234）");
    return;
  }

  // start/reset
  if (action === "start" || action === "reset") {
    recordState.startedAtMs = Date.now();
    recordState.region = region;
    recordState.platform = platform;
    recordState.name = name;
    recordState.tag = tag;

    recordCache = { key: "", expiresAt: 0, text: "" };

    const msg = clampText(`✅ Record 已開始：${name}#${tag}（${fmtTimeTaipei(recordState.startedAtMs)}）`);
    res.type("text/plain; charset=utf-8").send(msg);
    return;
  }

  if (!recordState.startedAtMs) {
    res.type("text/plain; charset=utf-8")
      .status(400)
      .send("尚未開始記錄，請先呼叫 /record?action=start");
    return;
  }

  // 如果你想強制只能查同一個帳號，取消註解
  // if (recordState.region !== region || recordState.platform !== platform || recordState.name !== name || recordState.tag !== tag) {
  //   res.type("text/plain; charset=utf-8").status(400).send("record 已綁定其他帳號，請用 action=start 重新開始");
  //   return;
  // }

  const cacheKey = `record::${region}::${platform}::${name}#${tag}::${recordState.startedAtMs}`;
  const now = Date.now();

  if (recordCache.key === cacheKey && recordCache.expiresAt > now) {
    res.type("text/plain; charset=utf-8").send(clampText(recordCache.text));
    return;
  }

  const upstream = await fetchHenrikMatchesSince(region, platform, name, tag, recordState.startedAtMs, "competitive");
  if (!upstream.ok) {
    const out = clampText(upstream.text);
    recordCache = { key: cacheKey, expiresAt: now + 15_000, text: out };
    res.type("text/plain; charset=utf-8").status(502).send(out);
    return;
  }

  const startedAt = recordState.startedAtMs;

  let wins = 0;
  let losses = 0;
  let counted = 0;

  for (const match of upstream.matches) {
    const gameStartMs = getMatchGameStartMs(match);
    if (!gameStartMs) continue;
    if (gameStartMs < startedAt) continue;

    const team = findPlayerTeam(match, name, tag);
    const w = didPlayerWin(match, team);
    if (w === true) { wins++; counted++; }
    else if (w === false) { losses++; counted++; }
  }

  const since = fmtTimeTaipei(startedAt);
  const text = `📊 本次開台戰績（自 ${since}）｜勝 ${wins} 敗 ${losses}｜共 ${counted} 場`;

  recordCache = { key: cacheKey, expiresAt: now + 90_000, text };
  res.type("text/plain; charset=utf-8").send(clampText(text));
});

app.listen(PORT, () => {
  console.log(`🟢 API listening on http://127.0.0.1:${PORT}`);
});
