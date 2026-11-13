// =====================================================================
//  محرك التعرف على الإشارة (بيشتغل في المتصفح وفي الاختبار)
//  الفكرة:
//   1) MediaPipe بيطلّع 21 نقطة لكل يد.
//   2) بنحوّل النقاط لأرقام مستقلة عن مكان اليد وبُعدها عن الكاميرا (normalize).
//   3) بنقارنها بالإشارات اللي أنتِ علّمتيها (kNN = أقرب الجيران).
//   4) المثبّت بيتأكد إن الإشارة ثابتة كذا فريم قبل ما يكتبها.
// =====================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HAND_LEN = 63;                 // 21 نقطة × (x,y,z)
  const FEATURE_LEN = HAND_LEN * 2 + 3; // يمين + شمال + فرق موضع اليدين

  // نقاط يد واحدة -> 63 رقم (نسبة للرسغ ومقيّسة بحجم اليد)
  function normalizeHand(lm) {
    const w = lm[0];
    let scale = 0;
    for (const p of lm) {
      const d = Math.hypot(p.x - w.x, p.y - w.y, p.z - w.z);
      if (d > scale) scale = d;
    }
    if (scale < 1e-6) scale = 1;
    const out = new Array(HAND_LEN);
    for (let i = 0; i < 21; i++) {
      out[i * 3] = (lm[i].x - w.x) / scale;
      out[i * 3 + 1] = (lm[i].y - w.y) / scale;
      out[i * 3 + 2] = (lm[i].z - w.z) / scale;
    }
    return { vec: out, scale };
  }

  // hands = [{ landmarks:[21 نقطة], handedness:'Left'|'Right' }]  ->  متجه بطول FEATURE_LEN
  function buildFeatures(hands) {
    if (!hands || !hands.length) return null;
    const out = new Array(FEATURE_LEN).fill(0);
    let right = null, left = null;
    for (const h of hands.slice(0, 2)) {
      if (h.handedness === 'Left' && !left) left = h;
      else if (!right) right = h;
      else if (!left) left = h;
    }
    let sR = 0, sL = 0;
    if (right) { const n = normalizeHand(right.landmarks); out.splice(0, HAND_LEN, ...n.vec); sR = n.scale; }
    if (left) { const n = normalizeHand(left.landmarks); out.splice(HAND_LEN, HAND_LEN, ...n.vec); sL = n.scale; }
    if (right && left) {
      const s = Math.max(sR, sL) || 1;
      const a = right.landmarks[0], b = left.landmarks[0];
      out[HAND_LEN * 2] = (a.x - b.x) / s;
      out[HAND_LEN * 2 + 1] = (a.y - b.y) / s;
      out[HAND_LEN * 2 + 2] = (a.z - b.z) / s;
    }
    return out.map((v) => Math.round(v * 1000) / 1000);
  }

  function dist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }

  // samples = [{label, features}] . بيرجّع {label, distance, confidence} أو null
  function classify(features, samples, opts = {}) {
    const k = opts.k || 5;
    const maxDistance = opts.maxDistance || 2.0;
    if (!features || !samples.length) return null;
    const scored = samples.map((s) => ({ label: s.label, d: dist(features, s.features) }));
    scored.sort((x, y) => x.d - y.d);
    const top = scored.slice(0, k);
    if (top[0].d > maxDistance) return null;           // بعيد عن أي إشارة معروفة
    const votes = new Map();
    let total = 0;
    for (const t of top) {
      const w = 1 / (t.d + 0.05);
      votes.set(t.label, (votes.get(t.label) || 0) + w);
      total += w;
    }
    let best = null, bw = 0;
    for (const [label, w] of votes) if (w > bw) { best = label; bw = w; }
    const nearest = top.find((t) => t.label === best).d;
    return { label: best, distance: nearest, confidence: bw / total };
  }

  // مثبّت: بيكتب الكلمة بس لما تثبت `needed` فريم ورا بعض،
  // وما بيكرّرهاش إلا بعد ما اليد تتشال (أو الإشارة تتغيّر)
  class Stabilizer {
    constructor(needed = 8, releaseFrames = 10) {
      this.needed = needed; this.releaseFrames = releaseFrames;
      this.cur = null; this.count = 0; this.committed = null; this.empty = 0;
    }
    push(label) {
      if (!label) {
        this.empty++;
        this.cur = null; this.count = 0;
        if (this.empty >= this.releaseFrames) this.committed = null;
        return null;
      }
      this.empty = 0;
      if (label === this.cur) this.count++;
      else { this.cur = label; this.count = 1; }
      if (this.count >= this.needed && label !== this.committed) {
        this.committed = label;
        return label;
      }
      return null;
    }
    reset() { this.cur = null; this.count = 0; this.committed = null; this.empty = 0; }
  }

  return { HAND_LEN, FEATURE_LEN, normalizeHand, buildFeatures, classify, Stabilizer };
});
