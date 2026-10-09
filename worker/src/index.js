// GotU push server. One Durable Object per user holds their schedule and sets its own alarm
// for the next event, so there is no cron and no polling. Same idea as the Android app's reconcile().
import { newVapid, sendPush } from './push.js';

const MIN = 60000;
const ALL_TYPES = ['WATER', 'EYE_DROPS'];
const DEF = { startHour: 8, endHour: 22, intervalMin: 60, snoozeMin: 10, graceMin: 15, missedAfterMin: 30 };
// Only real push services, so the server can't be pointed at arbitrary URLs.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w.-]+\.push\.apple\.com|[\w.-]+\.notify\.windows\.com)$/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (Number.isFinite(+v) ? Math.round(+v) : d);
const isActive = r => r.status === 'PENDING' || r.status === 'SNOOZED';

export function coerce(c = {}) {
  const s = clamp(num(c.startHour, DEF.startHour), 0, 22), g = clamp(num(c.graceMin, DEF.graceMin), 5, 120);
  return {
    startHour: s, endHour: clamp(num(c.endHour, DEF.endHour), s + 1, 23),
    intervalMin: clamp(num(c.intervalMin, DEF.intervalMin), 15, 240), snoozeMin: clamp(num(c.snoozeMin, DEF.snoozeMin), 5, 30),
    graceMin: g, missedAfterMin: clamp(num(c.missedAfterMin, DEF.missedAfterMin), g + 5, 180),
  };
}

// ---------- time zone maths (no library) ----------
function parts(ts, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ts)))
    o[p.type] = +p.value;
  o.hour %= 24;
  return o;
}
const offset = (ts, tz) => { const p = parts(ts, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000; };
function atLocal(y, m, d, min, tz) { const g = Date.UTC(y, m - 1, d, 0, min); return g - offset(g - offset(g, tz), tz); }
function daySlots(y, m, d, c, tz) {
  const out = [];
  for (let min = c.startHour * 60; min <= c.endHour * 60; min += c.intervalMin) out.push(atLocal(y, m, d, min, tz));
  return out;
}
const today = (now, tz) => { const p = parts(now, tz); return [p.year, p.month, p.day]; };
const tomorrow = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d + 1)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };
export function nextSlot(now, c, tz) {
  const [y, m, d] = today(now, tz);
  return daySlots(y, m, d, c, tz).find(t => t > now) ?? daySlots(...tomorrow(y, m, d), c, tz)[0];
}
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const validSub = s => {
  try { return new URL(s.endpoint).protocol === 'https:' && PUSH_HOSTS.test(new URL(s.endpoint).hostname) && !!s.keys.p256dh && !!s.keys.auth; } catch { return false; }
};

// ---------- Worker: routes /<uid>/<op> to that user's Durable Object ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const m = new URL(req.url).pathname.match(/^\/([a-f0-9]{32})\/(vapid|sync|act)$/);
    if (!m) return json({ error: 'not found' }, 404);
    return env.GOTU.get(env.GOTU.idFromName(m[1])).fetch(req);
  },
};

export class GotuUser {
  constructor(state, env) {
    this.s = state.storage;
    this.q = Promise.resolve();
    // Which reminders this deployment sends, e.g. TYPES="WATER" for a water-only app.
    const wanted = String((env && env.TYPES) || '').split(',').map(t => t.trim()).filter(t => ALL_TYPES.includes(t));
    this.types = wanted.length ? wanted : ALL_TYPES;
  }
  lock(fn) { const r = this.q.then(fn); this.q = r.catch(() => {}); return r; } // one job at a time

  async fetch(req) {
    const url = new URL(req.url), [uid, op] = url.pathname.slice(1).split('/');
    if (op === 'vapid' && req.method === 'GET') return json(await this.lock(() => this.vapid(uid, Date.now())));
    if (req.method !== 'POST') return json({ error: 'bad request' }, 400);
    let b;
    try { b = await req.json(); } catch { b = {}; }
    if (op === 'sync') return json(await this.lock(() => this.sync(uid, b, url.origin, Date.now())));
    if (op === 'act') return json(await this.lock(() => this.act(uid, b, Date.now())));
    return json({ error: 'not found' }, 404);
  }

  alarm() { return this.tick(Date.now()); }
  tick(now) { return this.lock(async () => { const u = await this.s.get('u'); if (u) await this.run(u, now); }); }

  fresh(uid, now) { return { uid, cfg: { ...DEF }, tz: 'UTC', track: now, rows: [], nid: 1, vapid: null, sub: null, api: '' }; }

  async vapid(uid, now) {
    const u = (await this.s.get('u')) || this.fresh(uid, now);
    if (!u.vapid) { u.vapid = await newVapid(); await this.s.put('u', u); }
    return { key: u.vapid.pub };
  }

  async sync(uid, b, origin, now) {
    const u = (await this.s.get('u')) || this.fresh(uid, now);
    u.api = origin;
    if (typeof b.tz === 'string' && validTz(b.tz)) u.tz = b.tz;
    if (b.cfg) { u.cfg = coerce(b.cfg); u.track = now; } // changed schedule: never invent "missed" slots in the past
    if (u.vapid && validSub(b.sub)) u.sub = b.sub;
    await this.run(u, now);
    return this.view(u);
  }

  async act(uid, b, now) {
    const u = await this.s.get('u');
    if (!u) return { error: 'unknown user' };
    const r = u.rows.find(x => x.id === +b.id);
    if (r && isActive(r)) {
      if (b.act === 'done') { r.status = 'CONFIRMED'; r.doneAt = now; r.snoozeUntil = null; r.upd = now; }
      else if (b.act === 'snooze') { r.status = 'SNOOZED'; r.snoozeUntil = now + u.cfg.snoozeMin * MIN; r.upd = now; }
    }
    await this.run(u, now);
    return this.view(u);
  }

  view(u) { return { cfg: u.cfg, tz: u.tz, sub: !!u.sub, rows: [...u.rows].sort((a, b) => b.at - a.at || a.id - b.id) }; }

  // Create due slots, advance each open reminder (notify -> one follow-up -> missed). Idempotent.
  reconcile(u, now) {
    const c = u.cfg, sends = [];
    const ping = (r, fu) => { if (u.sub) sends.push({ r, fu }); };
    for (const t of daySlots(...today(now, u.tz), c, u.tz)) {
      if (t > now || t < u.track) continue;
      for (const type of this.types)
        if (!u.rows.some(r => r.type === type && r.at === t))
          u.rows.push({ id: u.nid++, type, at: t, status: 'PENDING', doneAt: null, snoozeUntil: null, init: false, follow: false, upd: now });
    }
    for (const r of u.rows) {
      if (!isActive(r)) continue;
      const fu = r.at + c.graceMin * MIN, ms = r.at + c.missedAfterMin * MIN;
      if (now >= ms) { r.status = 'MISSED'; r.snoozeUntil = null; r.upd = now; }
      else if (r.status === 'SNOOZED') {
        if (now >= r.snoozeUntil) { ping(r, false); r.status = 'PENDING'; r.snoozeUntil = null; r.init = true; r.follow = r.follow || now >= fu; r.upd = now; }
      } else if (!r.init) { ping(r, false); r.init = true; r.follow = now >= fu; r.upd = now; } // late (server was behind): one push is enough
      else if (!r.follow && now >= fu) { ping(r, true); r.follow = true; r.upd = now; }
    }
    u.rows = u.rows.filter(r => r.at > now - 14 * 864e5);
    return sends;
  }

  async run(u, now) {
    const sends = this.reconcile(u, now);
    await this.s.put('u', u);
    if (sends.length) {
      const codes = await Promise.all(sends.map(({ r, fu }) =>
        sendPush(u.sub, u.vapid, { uid: u.uid, api: u.api, id: r.id, type: r.type, at: r.at, followUp: fu, snoozeMin: u.cfg.snoozeMin }, u.api).catch(() => 0)));
      codes.forEach((code, i) => {
        const { r, fu } = sends[i];
        if (code === 404 || code === 410) u.sub = null;          // device unsubscribed
        else if (code < 200 || code >= 300) { if (fu) r.follow = false; else r.init = false; } // transient: retry in a minute
      });
      await this.s.put('u', u);
    }
    await this.s.setAlarm(Math.max(this.nextAlarm(u, now), now + 1000));
  }

  nextAlarm(u, now) {
    const c = u.cfg;
    let next = nextSlot(now, c, u.tz);
    for (const r of u.rows) {
      if (!isActive(r)) continue;
      const times = [r.at + c.missedAfterMin * MIN, r.snoozeUntil || 0, r.init ? 0 : now + MIN, r.status === 'PENDING' && r.init && !r.follow ? r.at + c.graceMin * MIN : 0];
      for (const t of times) if (t > now) next = Math.min(next, t);
    }
    return next;
  }
}
