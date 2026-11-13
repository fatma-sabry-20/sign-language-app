// قاعدة البيانات: SQLite مدمجة في Node.js (مفيش حاجة تتثبت إضافية)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  phone   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat        REAL,
  lng        REAL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id   INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  phone      TEXT NOT NULL,
  status     TEXT NOT NULL,      -- sent | failed | not_sent
  detail     TEXT
);

CREATE TABLE IF NOT EXISTS translations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,      -- sign_to_text | text_to_sign
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- عينات الإشارات اللي المستخدم بيعلّمها للتطبيق (كل عينة = 129 رقم من landmarks اليد)
CREATE TABLE IF NOT EXISTS samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  features   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_samples_user ON samples(user_id, label);

CREATE TABLE IF NOT EXISTS signs (
  word        TEXT PRIMARY KEY,
  emoji       TEXT NOT NULL,
  description TEXT NOT NULL
);
`);

// قاموس إشارات مبدئي (تقدر تزوده بعدين من جدول signs)
const seed = [
  ['مرحبا', '👋', 'لوّح بيدك المفتوحة'],
  ['شكرا', '🙏', 'ضع يدك على صدرك وحركها للأمام'],
  ['من فضلك', '🤲', 'يدان مفتوحتان للأعلى'],
  ['مساعدة', '🆘', 'قبضة على كف مفتوحة ثم ارفعهما'],
  ['محتاج', '🤲', 'يدان مفتوحتان تتجهان لجسمك'],
  ['أنا', '👆', 'أشر إلى صدرك'],
  ['بخير', '👍', 'إبهام للأعلى'],
  ['طبيب', '🩺', 'أصابع على المعصم كأنك تقيس النبض'],
  ['أين', '🤷', 'حرّك السبابة يمينًا ويسارًا'],
  ['جعان', '🍽️', 'يد على البطن مع حركة دائرية'],
  ['عطشان', '🥤', 'السبابة على الحلق ثم للأسفل'],
  ['اتصل', '📞', 'إبهام وخنصر عند الأذن'],
  ['أهلي', '👨‍👩‍👧', 'إشارة العائلة: يدان تلتفان في دائرة'],
  ['ألم', '😣', 'قبضتان تدوران قرب مكان الألم'],
  ['نعم', '✅', 'اهزز قبضتك للأعلى والأسفل'],
  ['لا', '❌', 'حرّك السبابة والوسطى مع الإبهام كفم يُغلق'],
  ['ماء', '💧', 'ثلاثة أصابع تلمس الذقن'],
  ['طوارئ', '🚨', 'يد مرفوعة مع هز سريع']
];
const ins = db.prepare('INSERT OR IGNORE INTO signs (word, emoji, description) VALUES (?, ?, ?)');
for (const s of seed) ins.run(...s);

module.exports = db;
