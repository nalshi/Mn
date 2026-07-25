// ========================================================
// 🧼 تعقيم المدخلات والمخرجات الخاصة بميزة "المساعد الذكي"
// تُستخدم في 3 نقاط:
//   1) عند حفظ إعدادات التاجر (bot_name / custom_rules)
//   2) عند استقبال رسالة العميل قبل إرسالها للـ LLM
//   3) عند استقبال رد الـ LLM قبل إعادته للعميل (دفاع من الدرجة الثانية
//      في حال قام الموديل بالخطأ بتوليد HTML/سكربت داخل رده)
// ========================================================

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

// ⚠️ الدالة الوحيدة المسؤولة عن الهروب من HTML بكل الميزة - أي نص يُعرض
// لاحقاً في واجهة (لوحة التاجر أو ودجت العميل) يجب أن يمر من هنا أولاً.
export function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

// تنظيف نص عام: إزالة أحرف التحكم غير المرئية (منها ما يُستخدم بهجمات
// حقن التوجيهات لإخفاء تعليمات داخل نص يبدو عادياً)، وقص الطول الأقصى.
export function sanitizePlainText(input, maxLength = 500) {
  if (typeof input !== 'string') return '';
  return input
    // إزالة أحرف التحكم (0x00-0x1F, 0x7F) باستثناء السطر الجديد والتاب
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

// اسم البوت: نص قصير بدون HTML، بدون أسطر متعددة
export function sanitizeBotName(name) {
  const clean = sanitizePlainText(String(name || ''), 40).replace(/\s+/g, ' ');
  return clean || 'المساعد الذكي';
}

const ALLOWED_TONES = new Set(['friendly', 'formal', 'funny', 'professional', 'concise']);
export function sanitizeTone(tone) {
  return ALLOWED_TONES.has(tone) ? tone : 'friendly';
}

// القواعد المخصصة: كل سطر = قاعدة. نحدد عدد الأسطر وطول كل سطر لمنع
// تضخيم الـ prompt (وبالتالي التكلفة) أو حقن نصوص طويلة جداً.
const MAX_RULES = 25;
const MAX_RULE_LENGTH = 200;

export function sanitizeCustomRules(rawRules) {
  let lines = [];
  if (Array.isArray(rawRules)) {
    lines = rawRules;
  } else if (typeof rawRules === 'string') {
    lines = rawRules.split('\n');
  }

  return lines
    .map((line) => sanitizePlainText(String(line || ''), MAX_RULE_LENGTH))
    .filter((line) => line.length > 0)
    .slice(0, MAX_RULES);
}

// رسالة العميل قبل إرسالها للـ LLM: تحديد طول أقصى معقول لرسالة دردشة
// (يمنع إغراق النموذج بنص ضخم يرفع التكلفة أو يحاول "تعويم" حقن التوجيهات)
export function sanitizeCustomerMessage(message) {
  return sanitizePlainText(String(message || ''), 1000);
}
