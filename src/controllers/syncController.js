import { HttpError } from '../security/rbac.js';
import { getCategoriesTree } from '../services/categories/categoryService.js';
import { ROLES } from '../config/constants.js';
import { syncStoreInfoToStorefront } from '../services/store/storeInfoSyncService.js';
import { syncCatalogToStorefront } from '../services/catalog/catalogSyncService.js';

// ========================================================
// 🔄 تحكم المزامنة والمسارات العامة
// ========================================================

// محمي بمفتاح داخلي منفصل عن توكن الجلسات (وليس بـ JWT) - يُستدعى من api.php
export async function syncUser({ env, ctx, body, request }) {
  const internalKey = request.headers.get('X-Internal-Key') || '';
  if (!env.INTERNAL_SYNC_KEY || internalKey !== env.INTERNAL_SYNC_KEY) {
    throw new HttpError('غير مصرح', 401);
  }

  // ⭐ إصلاح: عند فتح متجر جديد (تسجيل تاجر جديد بـ api.php)، كان هذا
  // المسار يكتفي بحفظ صف المستخدم بـ D1 فقط، دون رفع أي ملفات (info.json /
  // manifest / صفحات المنتجات) لمجلد المتجر بـ GitHub ولا عمل أي purge -
  // فتبقى واجهة المتجر الجديد بلا بيانات (404/فارغة) للزبائن حتى أول
  // تعديل يدوي من التاجر (منتج أو إعدادات). نتحقق هنا هل الصف موجود
  // مسبقاً قبل الـ upsert، وإذا كان تاجر جديد فعلاً، نطلق أول مزامنة
  // لمعلومات المتجر + كتالوج فارغ حتى تُنشأ ملفات المتجر ويُعمل لها purge
  // من أول لحظة.
  const existingRow = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(body.id).first();
  const isNewStore = !existingRow && body.role === ROLES.MERCHANT;

  await env.DB.prepare(
    `INSERT INTO users (id, username, role, store_name, phone, store_type, settings, fcm_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     username=excluded.username, role=excluded.role, store_name=excluded.store_name,
     phone=COALESCE(excluded.phone, users.phone),
     store_type=COALESCE(excluded.store_type, users.store_type),
     settings=COALESCE(excluded.settings, users.settings),
     fcm_token=COALESCE(excluded.fcm_token, users.fcm_token),
     created_at=COALESCE(users.created_at, excluded.created_at)`
  )
    .bind(
      body.id,
      body.username,
      body.role,
      body.store_name || null,
      body.phone || null,
      body.store_type || null,
      body.settings || null,
      body.fcm_token || null,
      body.created_at || Date.now()
    )
    .run();

  if (isNewStore && body.username) {
    let initialSettings = {};
    try {
      initialSettings = body.settings ? JSON.parse(body.settings) : {};
    } catch (e) {
      initialSettings = {};
    }
    ctx.waitUntil(
      syncStoreInfoToStorefront(env, body.username, {
        store_name: body.store_name || body.username,
        store_type: body.store_type || null,
        phone: body.phone || null,
        settings: initialSettings,
      })
    );
    // متجر جديد = بلا منتجات بعد، لكن لازم تُنشأ ملفات الكتالوج (فارغة)
    // ويُعمل لها purge حتى لا تفشل واجهة المتجر بالبحث عنها لأول مرة.
    ctx.waitUntil(syncCatalogToStorefront(env, body.username, body.id, []));
  }

  return { message: 'تمت مزامنة المستخدم' };
}

// ⭐ إضافة (2026-07-21): مزامنة بيانات العميل من api.php إلى D1، بنفس نمط
// syncUser تماماً (نفس آلية الحماية بـ X-Internal-Key). تُستدعى من
// sync_customer_to_worker() في api.php بعد كل تسجيل دخول ناجح للعميل.
export async function syncCustomer({ env, body, request }) {
  const internalKey = request.headers.get('X-Internal-Key') || '';
  if (!env.INTERNAL_SYNC_KEY || internalKey !== env.INTERNAL_SYNC_KEY) {
    throw new HttpError('غير مصرح', 401);
  }

  // ⭐ نحافظ على fcm_token الحالي للعميل بالـ D1 (COALESCE) عند كل مزامنة،
  // بنفس نمط syncUser تماماً، حتى لا تُفقد الإشعارات إذا لم يرسل api.php
  // التوكن ضمن هذه المزامنة.
  await env.DB.prepare(
    `INSERT INTO customers (id, full_name, phone, address, is_active, fcm_token, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     full_name=excluded.full_name,
     phone=COALESCE(excluded.phone, customers.phone),
     address=COALESCE(excluded.address, customers.address),
     is_active=excluded.is_active,
     fcm_token=COALESCE(excluded.fcm_token, customers.fcm_token),
     updated_at=excluded.updated_at`
  )
    .bind(
      body.id,
      body.full_name || null,
      body.phone || null,
      body.address || null,
      body.is_active !== undefined ? body.is_active : 1,
      body.fcm_token || null,
      Date.now()
    )
    .run();

  return { message: 'تمت مزامنة العميل' };
}

// ⭐ إضافة: مزامنة عكسية لحالة التذكرة من api.php (بعد موافقة/رفض/إلغاء/تسليم من
// النظام القديم) إلى D1، حتى لا تبقى التذكرة في D1 بحالتها القديمة (pending) وتُعتبر
// "تذكرة قائمة" قابلة للدمج مع طلب جديد لاحق لنفس العميل/التاجر — وهو ما كان يُعيد
// إحياء طلبات مُلغاة/مكتملة بالخطأ في MySQL بعد كل طلب جديد.
export async function syncTicketStatus({ env, body, request }) {
  const internalKey = request.headers.get('X-Internal-Key') || '';
  if (!env.INTERNAL_SYNC_KEY || internalKey !== env.INTERNAL_SYNC_KEY) {
    throw new HttpError('غير مصرح', 401);
  }
  if (!body.ticket_id || !body.status) {
    throw new HttpError('ticket_id و status مطلوبان', 400);
  }

  await env.DB.prepare(`UPDATE live_tickets SET status = ? WHERE ticket_id = ?`)
    .bind(body.status, body.ticket_id)
    .run();

  return { message: 'تمت مزامنة حالة التذكرة' };
}

// ⭐ العملاء (customers) والتجار/المناديب (users) في جدولين منفصلين، لذلك
// يجب حفظ توكن FCM بالجدول الصحيح حسب دور المستخدم، وإلا لن تصل أي إشعارات
// للعملاء لاحقاً رغم نجاح الحفظ ظاهرياً.
export async function saveFcmToken({ env, user, body }) {
  const fcmToken = body.fcm_token || '';
  if (!fcmToken) return {};

  if (user.role === ROLES.CUSTOMER) {
    await env.DB.prepare(`UPDATE customers SET fcm_token = ? WHERE id = ?`).bind(fcmToken, user.user_id).run();
  } else {
    await env.DB.prepare(`UPDATE users SET fcm_token = ? WHERE id = ?`).bind(fcmToken, user.user_id).run();
  }
  return {};
}

export async function getFirebaseConfig({ env }) {
  const config = {
    apiKey: env.FCM_API_KEY || '',
    authDomain: env.FCM_AUTH_DOMAIN || '',
    projectId: env.FCM_PROJECT_ID || '',
    messagingSenderId: env.FCM_SENDER_ID || '',
    appId: env.FCM_APP_ID || '',
    vapidKey: env.FCM_VAPID_KEY || '',
  };
  if (!config.apiKey) throw new HttpError('إعدادات الإشعارات غير مهيأة.', 500);
  return { config };
}

export async function getCategoriesTreeHandler({ env, user }) {
  const data = await getCategoriesTree(env, user.user_id);
  return { data };
}

export async function getPublicProducts({ env, user, body }) {
  const storeUsername = body.username || user?.username;
  if (!storeUsername) throw new HttpError('اسم المتجر مطلوب', 400);

  const merchantRow = await env.DB.prepare(`SELECT id FROM users WHERE username = ? AND role = 'merchant'`)
    .bind(storeUsername)
    .first();
  if (!merchantRow) throw new HttpError('المتجر غير موجود', 404);

  const publicProducts = await env.DB.prepare(
    `SELECT * FROM products WHERE merchant_id = ? AND is_available = 1 ORDER BY updated_at DESC`
  )
    .bind(merchantRow.id)
    .all();

  const data = publicProducts.results.map((p) => {
    try {
      p.options = JSON.parse(p.options || '[]');
    } catch (e) {
      p.options = [];
    }
    return p;
  });
  return { data };
}
