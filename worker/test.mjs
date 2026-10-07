// Run: node --test worker/test.mjs   (Node 20+, no dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import { GotuUser, nextSlot, coerce } from './src/index.js';
import { b64u } from './src/push.js';

const ist = (h, m = 0) => Date.UTC(2026, 9, 6, h, m) - 19800000; // 6 Oct 2026, India time
const DEF = coerce({});

class FakeStorage {
  m = new Map(); alarm = null;
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async setAlarm(t) { this.alarm = t; }
}

// A device: real keys so encryption runs for real, and we can decrypt what the server sends.
async function device() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64u.enc(pub), auth: b64u.enc(auth) } } };
}

async function decrypt(dev, body) {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), data = body.slice(21 + idlen);
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const e = new TextEncoder();
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, dev.kp.privateKey, 256));
  const cat = (...a) => Uint8Array.from(a.flatMap(x => [...x]));
  const ikm = await hk(dev.auth, secret, cat(e.encode('WebPush: info\0'), dev.pub, asPub), 32);
  const key = await crypto.subtle.importKey('raw', await hk(salt, ikm, e.encode('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: await hk(salt, ikm, e.encode('Content-Encoding: nonce\0'), 12) }, key, data));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

// Fresh user with a registered device, created at 9:50 IST.
async function setup(status = 201) {
  const st = new FakeStorage(), obj = new GotuUser({ storage: st }), dev = await device(), sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, init }); return { status }; };
  const uid = 'a'.repeat(32);
  await obj.vapid(uid, ist(9, 50));
  await obj.sync(uid, { tz: 'Asia/Kolkata', sub: dev.sub }, 'https://api.test', ist(9, 50));
  const rows = async () => (await st.get('u')).rows;
  const pushes = async () => Promise.all(sent.map(x => decrypt(dev, x.init.body)));
  return { st, obj, dev, sent, uid, rows, pushes, setStatus: s => { status = s; } };
}

test('slots follow active hours and roll over to tomorrow', () => {
  assert.equal(nextSlot(ist(10, 30), DEF, 'Asia/Kolkata'), ist(11));
  assert.equal(nextSlot(ist(22, 1), DEF, 'Asia/Kolkata'), ist(8) + 864e5);
  assert.equal(nextSlot(ist(2), DEF, 'Asia/Kolkata'), ist(8));
  assert.equal(nextSlot(ist(9), coerce({ intervalMin: 90 }), 'Asia/Kolkata'), ist(9, 30));
});

test('water and eye drops are independent; one push each, one follow-up, then missed', async () => {
  const t = await setup();
  assert.equal(t.st.alarm, ist(10));                       // alarm is set for the next slot
  await t.obj.tick(ist(10));
  let p = await t.pushes();
  assert.deepEqual(p.map(x => x.type).sort(), ['EYE_DROPS', 'WATER']);
  assert.equal(t.st.alarm, ist(10, 15));                   // next event = follow-up

  const water = p.find(x => x.type === 'WATER');
  await t.obj.act(t.uid, { id: water.id, act: 'done' }, ist(10, 5));
  let rows = await t.rows();
  assert.equal(rows.find(r => r.type === 'WATER').status, 'CONFIRMED');
  assert.equal(rows.find(r => r.type === 'EYE_DROPS').status, 'PENDING'); // untouched

  await t.obj.tick(ist(10, 15));
  p = await t.pushes();
  assert.equal(p.length, 3);                               // only the eye-drops follow-up was added
  assert.deepEqual([p[2].type, p[2].followUp], ['EYE_DROPS', true]);

  await t.obj.tick(ist(10, 30));
  await t.obj.tick(ist(10, 30));                           // running twice changes nothing
  rows = await t.rows();
  assert.equal(rows.find(r => r.type === 'EYE_DROPS').status, 'MISSED');
  assert.equal(rows.find(r => r.type === 'WATER').status, 'CONFIRMED');
  assert.equal((await t.pushes()).length, 3);
  assert.equal(t.st.alarm, ist(11));
});

test('snooze re-notifies once after the snooze time', async () => {
  const t = await setup();
  await t.obj.tick(ist(10));
  const eye = (await t.pushes()).find(x => x.type === 'EYE_DROPS');
  await t.obj.act(t.uid, { id: eye.id, act: 'snooze' }, ist(10, 2));
  assert.equal((await t.rows()).find(r => r.id === eye.id).status, 'SNOOZED');
  assert.equal(t.st.alarm, ist(10, 12));
  await t.obj.tick(ist(10, 12));
  const p = await t.pushes();
  assert.equal(p.length, 3);
  assert.equal(p[2].id, eye.id);
  assert.equal((await t.rows()).find(r => r.id === eye.id).status, 'PENDING');
});

test('a failed push is retried; a gone subscription is dropped', async () => {
  const t = await setup(500);
  await t.obj.tick(ist(10));
  assert.equal(t.sent.length, 2);
  assert.equal(t.st.alarm, ist(10, 1));                    // retry in one minute
  t.setStatus(201);
  await t.obj.tick(ist(10, 1));
  assert.equal(t.sent.length, 4);                          // both re-sent exactly once
  await t.obj.tick(ist(10, 2));
  assert.equal(t.sent.length, 4);

  const g = await setup(410);
  await g.obj.tick(ist(10));
  assert.equal((await g.st.get('u')).sub, null);
});

test('after the last slot, the next alarm is tomorrow morning; no device means no pushes', async () => {
  const t = await setup();
  await t.obj.tick(ist(22, 40));
  assert.equal(t.st.alarm, ist(8) + 864e5);

  const st = new FakeStorage(), obj = new GotuUser({ storage: st });
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  await obj.sync('b'.repeat(32), { tz: 'Asia/Kolkata' }, 'https://api.test', ist(9, 50));
  await obj.tick(ist(10));
  assert.equal((await st.get('u')).rows.length, 2);
});

test('changing the schedule never invents past missed reminders', async () => {
  const t = await setup();
  await t.obj.tick(ist(12));
  await t.obj.sync(t.uid, { cfg: { startHour: 8, endHour: 22, intervalMin: 30 } }, 'https://api.test', ist(12, 10));
  const rows = await t.rows();
  assert.ok(rows.filter(r => r.at >= ist(12, 10)).every(r => r.status === 'PENDING'));
  assert.ok(!rows.some(r => r.at === ist(11, 30)));
});
