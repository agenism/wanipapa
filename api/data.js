// 와니파파 투자노트 · 시세/뉴스 프록시 (Vercel Serverless Function)
// 브라우저에서 바로 못 부르는 시세·뉴스를 서버에서 대신 가져와 JSON으로 돌려줍니다.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const YH = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

async function yahooChart(symbol, range = "5d", interval = "1d") {
  let lastErr;
  for (const host of YH) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error("no result");
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function quote(symbol) {
  const res = await yahooChart(symbol, "5d", "1d");
  const m = res.meta || {};
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const price = m.regularMarketPrice ?? closes[closes.length - 1];
  const prev = closes.length >= 2 ? closes[closes.length - 2] : (m.chartPreviousClose ?? m.previousClose);
  const chg = price - prev;
  return {
    s: symbol, name: m.shortName || m.longName || symbol, cur: m.currency || "",
    price, prev, chg, pct: prev ? (chg / prev) * 100 : 0,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
    state: m.marketState || ""
  };
}

async function news() {
  const url = "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ko&gl=KR&ceid=KR:ko";
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map(m => {
    const g = tag => (m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || "";
    const clean = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    let title = clean(g("title")), source = clean(g("source"));
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return { title, link: clean(g("link")), source, time: Date.parse(clean(g("pubDate"))) || null };
  });
  return items;
}

async function fng() {
  const out = {};
  try {
    const r = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://edition.cnn.com/" } });
    const j = await r.json();
    out.stock = { score: Math.round(j.fear_and_greed.score), rating: j.fear_and_greed.rating, prev: Math.round(j.fear_and_greed.previous_close), week: Math.round(j.fear_and_greed.previous_1_week) };
  } catch (e) { out.stock = null; }
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=2");
    const j = await r.json();
    out.crypto = { score: Number(j.data[0].value), rating: j.data[0].value_classification, prev: Number(j.data[1]?.value) };
  } catch (e) { out.crypto = null; }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = req.query || {};
  try {
    if (q.type === "quotes") {
      const syms = String(q.symbols || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 80);
      const results = await Promise.allSettled(syms.map(quote));
      const data = {};
      results.forEach((r, i) => { if (r.status === "fulfilled") data[syms[i]] = r.value; });
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
      return res.status(200).json({ ok: true, at: Date.now(), data });
    }
    if (q.type === "history") {
      const range = ["1mo", "3mo", "6mo", "1y", "2y", "5y"].includes(q.range) ? q.range : "1y";
      const r = await yahooChart(String(q.symbol), range, "1d");
      const t = r.timestamp || [], c = r.indicators?.quote?.[0]?.close || [];
      const pts = t.map((ts, i) => [ts * 1000, c[i]]).filter(p => p[1] != null);
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
      return res.status(200).json({ ok: true, symbol: q.symbol, name: r.meta?.shortName || q.symbol, cur: r.meta?.currency || "", pts });
    }
    if (q.type === "news") {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
      return res.status(200).json({ ok: true, at: Date.now(), items: await news() });
    }
    if (q.type === "fng") {
      res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");
      return res.status(200).json({ ok: true, at: Date.now(), ...(await fng()) });
    }
    return res.status(400).json({ ok: false, error: "type=quotes|history|news|fng" });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
