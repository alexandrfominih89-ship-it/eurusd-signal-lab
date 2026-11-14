const express = require("express");
const webpush = require("web-push");

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 10000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// In-memory subscriptions: suitable for initial testing, not durable across restarts.
const subscriptions = new Map();
let lastSignal = null;

app.get("/health", (_req, res) => res.json({ ok: true, subscriptions: subscriptions.size, lastSignal }));

app.get("/vapid-public-key", (_req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: "VAPID keys not configured" });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: "Invalid push subscription" });
  }
  subscriptions.set(sub.endpoint, sub);
  res.status(201).json({ ok: true });
});

app.post("/unsubscribe", (req, res) => {
  if (req.body && req.body.endpoint) subscriptions.delete(req.body.endpoint);
  res.json({ ok: true });
});

async function pollSignal() {
  if (!TWELVE_DATA_API_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", "EUR/USD");
    url.searchParams.set("interval", "1min");
    url.searchParams.set("outputsize", "80");
    url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.values) || data.values.length < 30) return;

    const closes = data.values.map(v => Number(v.close)).reverse();
    const ema = (values, period) => {
      const k = 2 / (period + 1);
      return values.slice(1).reduce((acc, val) => acc.concat(acc[acc.length - 1] * (1-k) + val*k), [values[0]]).at(-1);
    };
    const e9 = ema(closes.slice(-40), 9);
    const e21 = ema(closes.slice(-60), 21);
    const rsi = (values, n=14) => {
      let gains=0, losses=0;
      for(let i=values.length-n;i<values.length;i++){const d=values[i]-values[i-1]; if(d>0) gains+=d; else losses-=d;}
      return losses===0 ? 100 : 100-100/(1+gains/losses);
    };
    const momentum = closes.at(-1) - closes.at(-4);
    const direction = e9>e21 && rsi(closes)>=53 && momentum>0 ? "UP" :
      e9<e21 && rsi(closes)<=47 && momentum<0 ? "DOWN" : "WAIT";
    const candleTime = data.values[0].datetime;
    const key = candleTime + ":" + direction;
    if (direction === "WAIT" || key === lastSignal) return;
    lastSignal = key;

    const payload = JSON.stringify({
      title: "EUR/USD Signal Lab",
      body: direction === "UP" ? "Сигнал: ВВЕРХ (UP). Это эвристика, не гарантия." : "Сигнал: ВНИЗ (DOWN). Это эвристика, не гарантия.",
      data: { direction, candleTime, url: process.env.APP_URL || "https://alexandrfominih89-ship-it.github.io/eurusd-signal-lab/" }
    });
    const results = await Promise.allSettled([...subscriptions.entries()].map(async ([endpoint, sub]) => {
      try { await webpush.sendNotification(sub, payload); }
      catch (err) { if (err.statusCode === 404 || err.statusCode === 410) subscriptions.delete(endpoint); else throw err; }
    }));
    console.log("Signal", key, "push outcomes:", results.map(r => r.status));
  } catch (err) {
    console.error("Polling error:", err.message);
  }
}

app.listen(PORT, () => {
  console.log("Push server listening on", PORT);
  pollSignal();
  setInterval(pollSignal, 60_000);
});
