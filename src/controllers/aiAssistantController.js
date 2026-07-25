import { HttpError } from '../security/rbac.js';
import { buildMasterSystemPrompt } from '../services/ai/systemPromptBuilder.js';
import { assertRateLimitOk } from '../services/ai/rateLimiter.js';
import {
  sanitizeBotName,
  sanitizeTone,
  sanitizeCustomRules,
  sanitizeCustomerMessage,
  sanitizePlainText,
  escapeHtml,
} from '../services/ai/sanitize.js';

// ========================================================
// 🤖 تحكم "المساعد الذكي الخاص بكل تاجر"
// ثلاث دوال:
//   - getAiAssistantConfig: يجلب إعدادات التاجر الحالية (للوحة التاجر)
//   - saveAiAssistantConfig: يحفظ إعدادات التاجر (محمي بـ JWT + دور MERCHANT)
//   - aiChat: مسار عام (public) يستخدمه عملاء المتجر لمحادثة المساعد
// ========================================================

const MAX_PRODUCTS_IN_PROMPT = 20;
const AI_MODEL = '@cf/meta/llama-3-8b-instruct'; // يمكن تبديله لاحقاً بموديل Gemini عبر واجهة موحدة

// --------------------------------------------------------
// جلب إعدادات المساعد الخاصة بالتاجر الحالي (يستخدمها التاجر عند فتح
// صفحة الإعدادات ليرى قيمه المحفوظة سابقاً)
// --------------------------------------------------------
export async function getAiAssistantConfig({ env, user }) {
  const row = await env.DB.prepare(
    `SELECT ai_enabled, bot_name, tone, custom_rules FROM merchant_ai_settings WHERE merchant_id = ?`
  )
    .bind(user.user_id)
    .first();

  if (!row) {
    return {
      data: { ai_enabled: false, bot_name: 'المساعد الذكي', tone: 'friendly', custom_rules: [] },
    };
  }

  let customRules = [];
  try {
    customRules = JSON.parse(row.custom_rules || '[]');
  } catch (e) {
    customRules = [];
  }

  return {
    data: {
      ai_enabled: !!row.ai_enabled,
      bot_name: row.bot_name,
      tone: row.tone,
      custom_rules: customRules,
    },
  };
}

// --------------------------------------------------------
// حفظ إعدادات المساعد (Prepared Statement فقط - لا دمج نصي بالـ SQL)
// --------------------------------------------------------
export async function saveAiAssistantConfig({ env, user, body }) {
  // 🧼 تعقيم كل حقل بمكانه الصحيح قبل أي تخزين
  const aiEnabled = body.ai_enabled === true || body.ai_enabled === 'true' || body.ai_enabled === 1 ? 1 : 0;
  const botName = sanitizeBotName(body.bot_name);
  const tone = sanitizeTone(body.tone);
  const customRules = sanitizeCustomRules(body.custom_rules); // مصفوفة أو نص متعدد الأسطر، كلاهما مدعوم

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS merchant_ai_settings (
      merchant_id TEXT PRIMARY KEY,
      ai_enabled INTEGER NOT NULL DEFAULT 0,
      bot_name TEXT NOT NULL DEFAULT 'المساعد الذكي',
      tone TEXT NOT NULL DEFAULT 'friendly',
      custom_rules TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `INSERT INTO merchant_ai_settings (merchant_id, ai_enabled, bot_name, tone, custom_rules, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       ai_enabled = excluded.ai_enabled,
       bot_name = excluded.bot_name,
       tone = excluded.tone,
       custom_rules = excluded.custom_rules,
       updated_at = excluded.updated_at`
  )
    .bind(user.user_id, aiEnabled, botName, tone, JSON.stringify(customRules), Date.now())
    .run();

  return {
    message: 'تم حفظ إعدادات المساعد الذكي بنجاح ✅',
    data: { ai_enabled: !!aiEnabled, bot_name: botName, tone, custom_rules: customRules },
  };
}

// --------------------------------------------------------
// مسار الدردشة العام الذي يستخدمه عملاء المتجر (بدون تسجيل دخول)
// --------------------------------------------------------
export async function aiChat({ request, env, ctx, body }) {
  const merchantId = String(body.merchant_id || '');
  if (!merchantId) throw new HttpError('معرّف المتجر مطلوب', 400);

  // 🚦 تحديد المعدل أولاً وقبل أي استعلام آخر - أرخص عملية ونوقف الهجوم مبكراً
  const clientIp = request.headers.get('CF-Connecting-IP') || '';
  await assertRateLimitOk(env, { merchantId, clientIp });

  // 🧼 تعقيم رسالة العميل قبل أي استخدام لها
  const customerMessage = sanitizeCustomerMessage(body.message);
  if (!customerMessage) throw new HttpError('الرسالة فارغة', 400);

  // --- جلب إعدادات المساعد الخاصة بهذا التاجر (Prepared Statement) ---
  const settingsRow = await env.DB.prepare(
    `SELECT ai_enabled, bot_name, tone, custom_rules FROM merchant_ai_settings WHERE merchant_id = ?`
  )
    .bind(merchantId)
    .first();

  if (!settingsRow || !settingsRow.ai_enabled) {
    return {
      reply: 'عذراً، المساعد الذكي غير مفعّل حالياً لهذا المتجر. تواصل مباشرة مع المتجر للمساعدة.',
      bot_name: 'المساعد',
    };
  }

  let customRules = [];
  try {
    customRules = JSON.parse(settingsRow.custom_rules || '[]');
  } catch (e) {
    customRules = [];
  }

  // --- جلب اسم المتجر (Prepared Statement) ---
  const storeRow = await env.DB.prepare(`SELECT store_name, username FROM users WHERE id = ?`)
    .bind(merchantId)
    .first();
  const storeName = storeRow?.store_name || storeRow?.username || 'المتجر';

  // --- جلب أول 20 منتج نشط لهذا التاجر (Prepared Statement) ---
  const productsResult = await env.DB.prepare(
    `SELECT id, name, price, discount, currency, quantity
     FROM products
     WHERE merchant_id = ? AND is_available = 1
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(merchantId, MAX_PRODUCTS_IN_PROMPT)
    .all();

  const systemPrompt = buildMasterSystemPrompt({
    storeName,
    botName: settingsRow.bot_name,
    tone: settingsRow.tone,
    customRules,
    products: productsResult.results || [],
  });

  // --- استدعاء نموذج الذكاء الاصطناعي (Cloudflare Workers AI) ---
  let aiReplyText;
  try {
    const aiResponse = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: customerMessage },
      ],
      max_tokens: 400,
    });
    aiReplyText = aiResponse?.response || '';
  } catch (error) {
    throw new HttpError('تعذّر الحصول على رد من المساعد الذكي حالياً، حاول لاحقاً.', 502);
  }

  if (!aiReplyText) {
    aiReplyText = 'عذراً، لم أستطع فهم طلبك، هل يمكنك إعادة صياغته؟';
  }

  // 🛡️ دفاع من الدرجة الثانية: حتى لو التزم النموذج بالتعليمات، نهرب أي HTML
  // من رده قبل إرجاعه، لأن الواجهة الأمامية قد تعرضه بدون تعقيم إضافي.
  const safeReply = escapeHtml(sanitizePlainText(aiReplyText, 2000));

  return { reply: safeReply, bot_name: escapeHtml(settingsRow.bot_name) };
}
