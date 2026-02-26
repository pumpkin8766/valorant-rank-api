import express from "express";
import dotenv from "dotenv";
import morgan from "morgan";

dotenv.config();
const DEFAULT_PLATFORM = (process.env.DEFAULT_PLATFORM || "pc").trim();

function normalizePlatform(platform) {
  const p = String(platform || "").toLowerCase().trim();
  const allowed = new Set(["pc", "console"]);
  if (!allowed.has(p)) return null;
  return p;
}

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

function rankToZhTW(tierPatched) {
  const t = String(tierPatched || "").trim();

  // 有些情況會回 "Unrated" 或空字串
  if (!t) return "未知:(";

  switch (t) {
    case "Unrated": return "未評級";

    case "Iron 1": return "鐵牌 1";
    case "Iron 2": return "鐵牌 2";
    case "Iron 3": return "鐵牌 3";

    case "Bronze 1": return "青銅 1";
    case "Bronze 2": return "青銅 2";
    case "Bronze 3": return "青銅 3";

    case "Silver 1": return "白銀 1";
    case "Silver 2": return "白銀 2";
    case "Silver 3": return "白銀 3";

    case "Gold 1": return "黃金 1";
    case "Gold 2": return "黃金 2";
    case "Gold 3": return "黃金 3";

    case "Platinum 1": return "白金 1";
    case "Platinum 2": return "白金 2";
    case "Platinum 3": return "白金 3";

    case "Diamond 1": return "鑽石 1";
    case "Diamond 2": return "鑽石 2";
    case "Diamond 3": return "鑽石 3";

    case "Ascendant 1": return "超凡 1";
    case "Ascendant 2": return "超凡 2";
    case "Ascendant 3": return "超凡 3";

    case "Immortal 1": return "神話 1";
    case "Immortal 2": return "神話 2";
    case "Immortal 3": return "神話 3";

    case "Radiant": return "輻能";

    // 有些來源可能會回傳大小寫/多空白不同（保險）
    case "IRON 1": return "鐵牌 1";
    case "IRON 2": return "鐵牌 2";
    case "IRON 3": return "鐵牌 3";
    case "BRONZE 1": return "青銅 1";
    case "BRONZE 2": return "青銅 2";
    case "BRONZE 3": return "青銅 3";
    case "SILVER 1": return "白銀 1";
    case "SILVER 2": return "白銀 2";
    case "SILVER 3": return "白銀 3";
    case "GOLD 1": return "黃金 1";
    case "GOLD 2": return "黃金 2";
    case "GOLD 3": return "黃金 3";
    case "PLATINUM 1": return "白金 1";
    case "PLATINUM 2": return "白金 2";
    case "PLATINUM 3": return "白金 3";
    case "DIAMOND 1": return "鑽石 1";
    case "DIAMOND 2": return "鑽石 2";
    case "DIAMOND 3": return "鑽石 3";
    case "ASCENDANT 1": return "超凡 1";
    case "ASCENDANT 2": return "超凡 2";
    case "ASCENDANT 3": return "超凡 3";
    case "IMMORTAL 1": return "神話 1";
    case "IMMORTAL 2": return "神話 2";
    case "IMMORTAL 3": return "神話 3";
    case "RADIANT": return "輻能";
    case "UNRATED": return "未評級";

    default: {
      // 再保險一次：統一大小寫後再判斷（仍維持 switch 寫法）
      const u = t.toUpperCase();
      switch (u) {
        case "UNRATED": return "未評級";
        case "RADIANT": return "輻能";
        default: return t; // 不認得就原樣回傳，避免噴錯
      }
    }
  }
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

  const cacheKey = `${region}::${platform}::${name}#${tag}::${recordState.startedAtMs}`;
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

// ================================
// Record (W/L since "start")
// ================================

/**
 * recordState 只存一份（你自己的台）
 * 如果你要做成多台共用，就改成 Map(key -> state)
 */
const recordState = {
  startedAtMs: null,
  region: null,
  name: null,
  tag: null
};

// 為了避免每次 !record 都去打上游，做個小快取
let recordCache = {
  key: "",
  expiresAt: 0,
  text: ""
};

function fmtTimeTaipei(ms) {
  // 簡單顯示：YYYY/MM/DD HH:mm (台灣)
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

async function fetchHenrikMatchesSince(region, platform, name, tag, startedAtMs, mode = "competitive") {
  if (!HENRIK_API_KEY) return { ok: false, text: "伺服器未設定 API Key（HENRIK_API_KEY）" };

  const SIZE = 10;                 // v4 size max 10 :contentReference[oaicite:4]{index=4}
  const MAX_PAGES = 30;            // 安全上限：最多 30 頁 = 300 場（你可改）
  const MAX_TOTAL_MATCHES = 300;   // 再多就截斷，避免刷爆上游
  const matches = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * SIZE;     // v4 start = pagination starting point :contentReference[oaicite:5]{index=5}

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

    // 只收 startTime 之後開始的對局（game_start 是 epoch 秒）
    for (const m of pageMatches) {
      const ms = getMatchGameStartMs(m);
      if (ms !== null && ms >= startedAtMs) matches.push(m);
    }

    if (matches.length >= MAX_TOTAL_MATCHES) break;

    // 提前停止：如果這一頁「最舊那場」都早於 startedAtMs，就不用再翻了
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
const platform = normalizePlatform(req.query.platform ?? DEFAULT_PLATFORM);
if (!platform) {
  res.type("text/plain; charset=utf-8").status(400).send("platform 需為 pc 或 console");
  return;
}

function findPlayerTeam(match, name, tag) {
  const all = match?.players?.all_players;
  if (!Array.isArray(all)) return null;

  // 盡量精準：name+tag
  const p = all.find(x =>
    String(x?.name ?? "").toLowerCase() === String(name).toLowerCase() &&
    String(x?.tag ?? "").toLowerCase() === String(tag).toLowerCase()
  );

  // team 會是 "Red" / "Blue" :contentReference[oaicite:3]{index=3}
  return p?.team ?? null;
}

function getMatchGameStartMs(match) {
  // metadata.game_start 是 epoch 秒 :contentReference[oaicite:4]{index=4}
  const sec = match?.metadata?.game_start;
  if (typeof sec === "number" && Number.isFinite(sec)) return sec * 1000;
  return null;
}

function didPlayerWin(match, playerTeam) {
  const teams = match?.teams;
  if (!teams || !playerTeam) return null;

  // docs 裡 teams.red/blue.has_won :contentReference[oaicite:5]{index=5}
  if (String(playerTeam).toLowerCase() === "red") return teams?.red?.has_won ?? null;
  if (String(playerTeam).toLowerCase() === "blue") return teams?.blue?.has_won ?? null;
  return null;
}

app.get("/record", async (req, res) => {
  const action = String(req.query.action ?? "").toLowerCase().trim();

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
      .send("缺少 name 或 tag（例：/record?region=ap&name=AAA&tag=1234）");
    return;
  }

  // ---------- start ----------
  if (action === "start" || action === "reset") {
    recordState.startedAtMs = Date.now();
    recordState.region = region;
    recordState.name = name;
    recordState.tag = tag;

    // 清 record 快取
    recordCache = { key: "", expiresAt: 0, text: "" };

    const msg = clampText(`✅ Record 已開始：${name}#${tag}（${fmtTimeTaipei(recordState.startedAtMs)}）`);
    res.type("text/plain; charset=utf-8").send(msg);
    return;
  }

  // ---------- show record ----------
  if (!recordState.startedAtMs) {
    res.type("text/plain; charset=utf-8")
      .status(400)
      .send("尚未開始記錄，請先呼叫 /record?action=start");
    return;
  }

  // 如果你想強制只能用同一個帳號統計，就開這段
  // if (recordState.name !== name || recordState.tag !== tag || recordState.region !== region) {
  //   res.type("text/plain; charset=utf-8").status(400).send("目前 record 已綁定另一個帳號，請用 action=start 重新開始");
  //   return;
  // }

  const cacheKey = `${region}::${name}#${tag}::${recordState.startedAtMs}`;
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

    // 只算 start 之後開始的對局
    if (gameStartMs < startedAt) continue;

    const team = findPlayerTeam(match, name, tag);
    const w = didPlayerWin(match, team);
    if (w === true) { wins++; counted++; }
    else if (w === false) { losses++; counted++; }
    else {
      // 有些非標準模式/異常資料可能抓不到結果
      // 這裡就不計入
    }
  }

  const since = fmtTimeTaipei(startedAt);
  const text = `📊 本次開台戰績（自 ${since}）｜勝 ${wins} 敗 ${losses}｜共 ${counted} 場`;

  // 快取 30 秒，Nightbot/觀眾狂刷也不會打爆上游
  recordCache = { key: cacheKey, expiresAt: now + 30_000, text };

  res.type("text/plain; charset=utf-8").send(clampText(text));
});

app.listen(PORT, () => {
  console.log(`🟢 API listening on http://127.0.0.1:${PORT}`);
});
