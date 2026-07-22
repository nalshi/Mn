import { HttpError } from '../security/rbac.js';
import { getCategoriesTree } from '../services/categories/categoryService.js';

// ========================================================
// 🔄 تحكم المزامنة والمسارات العامة
// ========================================================

// محمي بمفتاح داخلي منفصل عن توكن الجلسات (وليس بـ JWT) - يُستدعى من api.php
export async function syncUser({ env, body, request }) {
  const internalKey = request.headers.get('X-Internal-Key') || '';
  if (!env.INTERNAL_SYNC_KEY || internalKey !== env.INTERNAL_SYNC_KEY) {
    throw new HttpError('غير مصرح', 401);
  }

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

  await env.DB.prepare(
    `INSERT INTO customers (id, full_name, phone, address, is_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     full_name=excluded.full_name,
     phone=COALESCE(excluded.phone, customers.phone),
     address=COALESCE(excluded.address, customers.address),
     is_active=excluded.is_active,
     updated_at=excluded.updated_at`
  )
    .bind(
      body.id,
      body.full_name || null,
      body.phone || null,
      body.address || null,
      body.is_active !== undefined ? body.is_active : 1,
      Date.now()
    )
    .run();

  return { message: 'تمت مزامنة العميل' };
}

export async function saveFcmToken({ env, user, body }) {
  const fcmToken = body.fcm_token || '';
  if (fcmToken) {
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
