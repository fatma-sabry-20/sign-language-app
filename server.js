// =====================================================================
//  سيرفر تطبيق مترجم لغة الإشارة
//  الملف ده فيه كل الـ API. اقرأه من فوق لتحت وهتفهم كل حاجة.
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // الكاميرا والموقع مسموحين للصفحة نفسها فقط
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()'
  });
  next();
});

// ------------------------------ أدوات مساعدة ------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

// تنظيف الكلمات العربية عشان البحث في القاموس يكون مرن
function normalizeArabic(w) {
  return w
    .replace(/[ً-ْـ]/g, '')      // التشكيل والتطويل
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, '')            // علامات الترقيم
    .trim()
    .toLowerCase();
}

// رقم الهاتف: 01012345678 -> +201012345678
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^0\d{10}$/.test(p)) p = '+20' + p.slice(1);   // رقم مصري محلي
  if (/^20\d{10}$/.test(p)) p = '+' + p;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

// حد بسيط لعدد المحاولات (يحمي من تخمين كلمات السر)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'محاولات كتير. استنى شوية وجرّب تاني.' });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

// ------------------------------ الجلسات (تسجيل الدخول) ------------------------------
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  res.append(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${IS_PROD ? '; Secure' : ''}`
  );
}

// middleware: لازم يكون مسجل دخول
function auth(req, res, next) {
  const token = parseCookies(req).sid;
  if (!token) return res.status(401).json({ error: 'سجّل دخول الأول' });
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row || row.expires_at < Date.now()) return res.status(401).json({ error: 'الجلسة انتهت، سجّل دخول تاني' });
  req.user = { id: row.id, name: row.name, email: row.email };
  next();
}

// ------------------------------ الحسابات ------------------------------
app.post('/api/auth/register', rateLimit(10, 60_000), (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'اكتب اسم صحيح' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'الإيميل غير صحيح' });
  if (password.length < 8) return res.status(400).json({ error: 'كلمة السر لازم تكون 8 حروف أو أكتر' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'الإيميل ده مسجل قبل كده' });

  const r = db.prepare('INSERT INTO users (name, email, pass_hash) VALUES (?, ?, ?)').run(name, email, hashPassword(password));
  createSession(res, Number(r.lastInsertRowid));
  res.status(201).json({ user: { id: Number(r.lastInsertRowid), name, email } });
});

app.post('/api/auth/login', rateLimit(10, 60_000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !verifyPassword(password, u.pass_hash))
    return res.status(401).json({ error: 'الإيميل أو كلمة السر غلط' });
  createSession(res, u.id);
  res.json({ user: { id: u.id, name: u.name, email: u.email } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.append('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ------------------------------ جهات اتصال الطوارئ ------------------------------
const MAX_CONTACTS = 10;

app.get('/api/contacts', auth, (req, res) => {
  res.json({ contacts: db.prepare('SELECT id, name, phone FROM contacts WHERE user_id = ? ORDER BY id').all(req.user.id) });
});

app.post('/api/contacts', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  if (!name || name.length > 60) return res.status(400).json({ error: 'اكتب الاسم' });
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف غير صحيح (مثال: 01012345678)' });
  const count = db.prepare('SELECT COUNT(*) c FROM contacts WHERE user_id = ?').get(req.user.id).c;
  if (count >= MAX_CONTACTS) return res.status(400).json({ error: `الحد الأقصى ${MAX_CONTACTS} جهات اتصال` });
  const r = db.prepare('INSERT INTO contacts (user_id, name, phone) VALUES (?, ?, ?)').run(req.user.id, name, phone);
  res.status(201).json({ contact: { id: Number(r.lastInsertRowid), name, phone } });
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  // user_id في الشرط يمنع أي مستخدم من حذف جهات غيره
  const r = db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'غير موجود' });
  res.json({ ok: true });
});

// ------------------------------ الطوارئ ------------------------------
// إرسال SMS حقيقي عن طريق Twilio لو المفاتيح موجودة في .env
// لو مش موجودة: التنبيه يتسجل في قاعدة البيانات، والواجهة تفتح واتساب برسالة جاهزة.
const TWILIO = {
  sid: process.env.TWILIO_ACCOUNT_SID,
  token: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_FROM
};
const smsEnabled = !!(TWILIO.sid && TWILIO.token && TWILIO.from);

async function sendSms(to, body) {
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TWILIO.sid}:${TWILIO.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: to, From: TWILIO.from, Body: body })
  });
  if (!resp.ok) throw new Error(`Twilio ${resp.status}`);
}

app.post('/api/sos', auth, rateLimit(5, 60_000), async (req, res) => {
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  const contacts = db.prepare('SELECT name, phone FROM contacts WHERE user_id = ?').all(req.user.id);
  if (!contacts.length) return res.status(400).json({ error: 'ضيف جهة اتصال واحدة على الأقل في تاب «الأهل» الأول' });

  const message =
    `🚨 تنبيه طوارئ: ${req.user.name} محتاج مساعدة عاجلة!` +
    (hasLoc ? ` موقعه: https://maps.google.com/?q=${lat},${lng}` : ' (الموقع غير متاح)');

  const a = db.prepare('INSERT INTO alerts (user_id, lat, lng, message) VALUES (?, ?, ?, ?)')
    .run(req.user.id, hasLoc ? lat : null, hasLoc ? lng : null, message);
  const alertId = Number(a.lastInsertRowid);

  const results = [];
  for (const c of contacts) {
    let status = 'not_sent';
    let detail = 'SMS غير مفعّل على السيرفر - استخدم زر واتساب';
    if (smsEnabled) {
      try { await sendSms(c.phone, message); status = 'sent'; detail = 'تم الإرسال'; }
      catch (e) { status = 'failed'; detail = e.message; }
    }
    db.prepare('INSERT INTO alert_deliveries (alert_id, contact_name, phone, status, detail) VALUES (?, ?, ?, ?, ?)')
      .run(alertId, c.name, c.phone, status, detail);
    results.push({
      name: c.name, phone: c.phone, status, detail,
      // رابط واتساب جاهز برسالة الطوارئ (شغال من غير أي خدمة خارجية)
      whatsapp: `https://wa.me/${c.phone.replace('+', '')}?text=${encodeURIComponent(message)}`
    });
  }
  res.status(201).json({ alertId, smsEnabled, message, results });
});

app.get('/api/sos/history', auth, (req, res) => {
  const rows = db.prepare('SELECT id, message, created_at FROM alerts WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({ alerts: rows });
});

// ------------------------------ الترجمة ------------------------------
// نص -> إشارات: بيدور على كل كلمة في جدول signs
app.post('/api/text-to-sign', auth, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'اكتب جملة' });

  const dict = new Map();
  for (const s of db.prepare('SELECT word, emoji, description FROM signs').all()) dict.set(normalizeArabic(s.word), s);

  const words = text.split(/\s+/).filter(Boolean);
  const signs = words.map((w) => {
    const hit = dict.get(normalizeArabic(w));
    return hit
      ? { word: w, found: true, emoji: hit.emoji, description: hit.description }
      : { word: w, found: false, emoji: '❔', description: 'الكلمة دي لسه مش في القاموس' };
  });
  db.prepare('INSERT INTO translations (user_id, direction, content) VALUES (?, ?, ?)').run(req.user.id, 'text_to_sign', text);
  res.json({ signs });
});

// ------------------------------ تعليم الإشارات (عينات) ------------------------------
// المستخدم بيسجّل إشارة بالكاميرا، والواجهة بتبعت landmarks اليد هنا، وبتتخزن في قاعدة البيانات.
// التعرف نفسه بيحصل في المتصفح (أسرع) باستخدام العينات دي.
const FEATURE_LEN = 129;
const MAX_SAMPLES_PER_USER = 6000;
const MAX_BATCH = 100;

app.get('/api/samples', auth, (req, res) => {
  const rows = db.prepare('SELECT label, features FROM samples WHERE user_id = ?').all(req.user.id);
  res.json({ samples: rows.map((r) => ({ label: r.label, features: JSON.parse(r.features) })) });
});

app.get('/api/samples/labels', auth, (req, res) => {
  res.json({
    labels: db.prepare('SELECT label, COUNT(*) AS count FROM samples WHERE user_id = ? GROUP BY label ORDER BY label').all(req.user.id)
  });
});

app.post('/api/samples', auth, (req, res) => {
  const label = String(req.body.label || '').trim();
  const batch = req.body.samples;
  if (!label || label.length > 40) return res.status(400).json({ error: 'اكتب اسم الإشارة (كلمة قصيرة)' });
  if (!Array.isArray(batch) || !batch.length || batch.length > MAX_BATCH) return res.status(400).json({ error: 'عينات غير صحيحة' });
  for (const f of batch) {
    if (!Array.isArray(f) || f.length !== FEATURE_LEN || !f.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100))
      return res.status(400).json({ error: 'شكل العينات غير صحيح' });
  }
  const total = db.prepare('SELECT COUNT(*) c FROM samples WHERE user_id = ?').get(req.user.id).c;
  if (total + batch.length > MAX_SAMPLES_PER_USER) return res.status(400).json({ error: 'وصلت للحد الأقصى من العينات. احذف إشارات قديمة.' });

  const ins = db.prepare('INSERT INTO samples (user_id, label, features) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try { for (const f of batch) ins.run(req.user.id, label, JSON.stringify(f)); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  res.status(201).json({ added: batch.length });
});

app.delete('/api/samples/:label', auth, (req, res) => {
  const r = db.prepare('DELETE FROM samples WHERE user_id = ? AND label = ?').run(req.user.id, req.params.label);
  if (!r.changes) return res.status(404).json({ error: 'غير موجود' });
  res.json({ deleted: Number(r.changes) });
});

// حفظ كلمة اتعرّف عليها من الكاميرا في السجل
app.post('/api/translations', auth, (req, res) => {
  const content = String(req.body.content || '').trim().slice(0, 500);
  if (!content) return res.status(400).json({ error: 'فاضي' });
  db.prepare('INSERT INTO translations (user_id, direction, content) VALUES (?, ?, ?)').run(req.user.id, 'sign_to_text', content);
  res.status(201).json({ ok: true });
});

app.get('/api/translations', auth, (req, res) => {
  res.json({
    translations: db.prepare('SELECT direction, content, created_at FROM translations WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id)
  });
});

// ------------------------------ الواجهة + أخطاء ------------------------------
app.use('/vendor/mediapipe', express.static(path.join(__dirname, 'node_modules/@mediapipe/tasks-vision')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'مسار غير موجود' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'بيانات غير صحيحة' });
  console.error(err);
  res.status(500).json({ error: 'حصل خطأ في السيرفر' });
});

// تنظيف الجلسات المنتهية كل ساعة
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref();

// موديل تتبع اليد (من جوجل، ~8MB). بيتنزّل مرة واحدة أول تشغيل ويتخزن في public/models
const MODEL_PATH = path.join(__dirname, 'public/models/hand_landmarker.task');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
async function ensureHandModel() {
  if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 1e6) return;
  try {
    fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(MODEL_PATH, Buffer.from(await r.arrayBuffer()));
    console.log('🖐️  تم تنزيل موديل تتبع اليد');
  } catch (e) {
    console.log('⚠️  تعذر تنزيل موديل اليد (' + e.message + '). المتصفح هيحمّله مباشرة من جوجل.');
  }
}

if (require.main === module) {
  ensureHandModel();
  app.listen(PORT, () => {
    console.log(`✅ التطبيق شغال على http://localhost:${PORT}`);
    console.log(smsEnabled ? '📲 SMS: مفعّل (Twilio)' : '📲 SMS: غير مفعّل - الطوارئ هتتسجل + أزرار واتساب');
  });
}
module.exports = app;
