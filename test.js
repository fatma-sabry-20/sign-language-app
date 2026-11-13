// اختبار آلي: بيشغّل السيرفر على قاعدة بيانات مؤقتة ويجرّب كل الـ API
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
let cookie = '';
let passed = 0, failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.log('  ❌', name, extra); }
}
async function call(method, url, body, useCookie = true) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('sid=') && !sc.startsWith('sid=;')) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

function coreTests() {
  const Core = require('./public/sign-core.js');
  console.log('محرك التعرف');
  // يد وهمية: 21 نقطة، "مفتوحة" مقابل "قبضة"
  const mk = (open, dx = 0, dy = 0, sc = 1) => Array.from({ length: 21 }, (_, i) => {
    const finger = Math.ceil(i / 4), joint = i % 4 || 4;
    const len = open ? joint * 0.08 : joint * 0.02;
    return { x: (0.5 + (finger - 2) * 0.05 + dx) * sc, y: (0.8 - (i === 0 ? 0 : len)) * sc + dy, z: 0 };
  });
  const f = (open, dx, dy, sc) => Core.buildFeatures([{ landmarks: mk(open, dx, dy, sc), handedness: 'Right' }]);
  check('طول المتجه 129', f(true).length === Core.FEATURE_LEN);
  const d = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  check('تحريك اليد لا يغيّر الأرقام', d(f(true), f(true, 0.2, -0.1)) < 0.01);
  check('تكبير/تصغير اليد لا يغيّر الأرقام', d(f(true), f(true, 0, 0, 0.5)) < 0.05);
  check('مفتوحة ≠ قبضة', d(f(true), f(false)) > 1);
  const samples = [];
  for (let i = 0; i < 10; i++) { samples.push({ label: 'مفتوحة', features: f(true, i * 0.01, 0) }); samples.push({ label: 'قبضة', features: f(false, i * 0.01, 0) }); }
  const r1 = Core.classify(f(true, 0.3, 0.2, 0.7), samples);
  const r2 = Core.classify(f(false, -0.2, 0.1, 1.3), samples);
  check('بتتعرف على المفتوحة', r1 && r1.label === 'مفتوحة' && r1.confidence > 0.9);
  check('بتتعرف على القبضة', r2 && r2.label === 'قبضة');
  check('إشارة بعيدة = غير معروفة', Core.classify(f(true).map((v) => v + 5), samples) === null);
  check('بدون يد = null', Core.buildFeatures([]) === null);
  const st = new Core.Stabilizer(3, 2);
  const out = ['أ', 'أ', 'أ', 'أ', 'أ', null, null, 'أ', 'أ', 'أ'].map((l) => st.push(l)).filter(Boolean);
  check('المثبّت بيكتب مرة واحدة وبيكرر بعد رفع اليد', out.length === 2 && out[0] === 'أ');
  const st2 = new Core.Stabilizer(3, 2);
  check('وميض لحظي ما بيتكتبش', ['أ', 'ب', 'أ', 'ب'].map((l) => st2.push(l)).every((x) => x === null));
}

(async () => {
  coreTests();
  // نسخة مؤقتة من المشروع عشان الاختبار ما يلمسش قاعدة بياناتك الحقيقية
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signapp-'));
  fs.cpSync(__dirname, tmp, { recursive: true, filter: (s) => s !== path.join(__dirname, 'data') });
  const srv = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, PORT }, stdio: ['ignore','inherit','inherit'] });
  await new Promise((res) => setTimeout(res, 1500));

  try {
    console.log('الحسابات');
    let r = await call('GET', '/api/me');
    check('بدون دخول = 401', r.status === 401);
    r = await call('POST', '/api/auth/register', { name: 'فاطمة', email: 'a@b.com', password: '123' });
    check('كلمة سر قصيرة مرفوضة', r.status === 400);
    r = await call('POST', '/api/auth/register', { name: 'فاطمة', email: 'a@b.com', password: '12345678' });
    check('تسجيل حساب جديد', r.status === 201 && cookie.startsWith('sid='));
    r = await call('POST', '/api/auth/register', { name: 'x y', email: 'a@b.com', password: '12345678' }, false);
    check('إيميل مكرر مرفوض', r.status === 409);
    r = await call('GET', '/api/me');
    check('/api/me بعد الدخول', r.status === 200 && r.data.user.name === 'فاطمة');
    r = await call('POST', '/api/auth/login', { email: 'a@b.com', password: 'غلط12345' }, false);
    check('كلمة سر غلط مرفوضة', r.status === 401);

    console.log('جهات الاتصال');
    r = await call('POST', '/api/contacts', { name: 'ماما', phone: 'abc' });
    check('رقم غلط مرفوض', r.status === 400);
    r = await call('POST', '/api/contacts', { name: 'ماما', phone: '01145857004' });
    check('إضافة جهة + تحويل الرقم لصيغة دولية', r.status === 201 && r.data.contact.phone === '+201145857004');
    const id = r.data.contact.id;
    r = await call('GET', '/api/contacts');
    check('قائمة الجهات', r.data.contacts.length === 1);

    console.log('عزل المستخدمين');
    const mine = cookie;
    cookie = '';
    await call('POST', '/api/auth/register', { name: 'مستخدم تاني', email: 'c@d.com', password: '12345678' });
    r = await call('GET', '/api/contacts');
    check('المستخدم التاني مش شايف جهات الأول', r.data.contacts.length === 0);
    r = await call('DELETE', '/api/contacts/' + id);
    check('المستخدم التاني مش بيقدر يحذف جهة الأول', r.status === 404);
    cookie = mine;

    console.log('الطوارئ');
    r = await call('POST', '/api/sos', { lat: 26.55, lng: 31.69 });
    check('إرسال تنبيه', r.status === 201 && r.data.results.length === 1);
    check('الرسالة فيها رابط الموقع', r.data.message.includes('maps.google.com/?q=26.55,31.69'));
    check('رابط واتساب جاهز', r.data.results[0].whatsapp.startsWith('https://wa.me/201145857004'));
    r = await call('GET', '/api/sos/history');
    check('التنبيه اتسجل في السجل', r.data.alerts.length === 1);

    console.log('الترجمة');
    r = await call('POST', '/api/text-to-sign', { text: 'أنا محتاج مساعدة؟ كلمةغريبة' });
    check('كلمات القاموس اتلقت', r.data.signs[0].found && r.data.signs[1].found && r.data.signs[2].found);
    check('كلمة مش في القاموس', r.data.signs[3].found === false);

    console.log('عينات الإشارات');
    const feat = (v) => Array.from({ length: 129 }, (_, i) => v + i / 1000);
    r = await call('POST', '/api/samples', { label: 'مرحبا', samples: [[1, 2, 3]] });
    check('عينة بطول غلط مرفوضة', r.status === 400);
    r = await call('POST', '/api/samples', { label: 'مرحبا', samples: [feat(0.1), feat(0.11)] });
    check('حفظ عينات', r.status === 201 && r.data.added === 2);
    r = await call('GET', '/api/samples');
    check('قراءة العينات', r.data.samples.length === 2 && r.data.samples[0].features.length === 129);
    r = await call('GET', '/api/samples/labels');
    check('ملخص الإشارات', r.data.labels[0].label === 'مرحبا' && r.data.labels[0].count === 2);
    const mine2 = cookie; cookie = '';
    await call('POST', '/api/auth/register', { name: 'تالت', email: 'e@f.com', password: '12345678' });
    r = await call('GET', '/api/samples');
    check('عينات المستخدم الأول مش ظاهرة لغيره', r.data.samples.length === 0);
    cookie = mine2;
    r = await call('DELETE', '/api/samples/' + encodeURIComponent('مرحبا'));
    check('حذف إشارة', r.status === 200 && r.data.deleted === 2);

    console.log('ملفات MediaPipe');
    const wasm = await fetch(BASE + '/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
    check('ملف wasm بيتخدّم بنوع application/wasm', wasm.status === 200 && wasm.headers.get('content-type') === 'application/wasm', wasm.headers.get('content-type'));
    const bundle = await fetch(BASE + '/vendor/mediapipe/vision_bundle.mjs');
    check('مكتبة التتبع متاحة', bundle.status === 200);

    console.log('الخروج');
    await call('POST', '/api/auth/logout');
    r = await call('GET', '/api/me');
    check('بعد الخروج = 401', r.status === 401);

    const html = await (await fetch(BASE + '/')).text();
    check('الواجهة بتتحمّل', html.includes('مترجم لغة الإشارة'));
  } catch (e) {
    failed++; console.log('❌ خطأ غير متوقع:', e.message);
  }
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})();
