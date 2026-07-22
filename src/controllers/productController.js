import { resolveCategoryChain } from '../services/categories/categoryService.js';
import { uploadProductImage } from '../services/images/imageService.js';
import { syncCatalogToStorefront } from '../services/catalog/catalogSyncService.js';
import { HttpError } from '../security/rbac.js';
import { ACTIVE_ORDER_STATUSES } from '../config/constants.js';

// ========================================================
// 🏪 تحكم المنتجات (تاجر فقط)
// ========================================================

export async function saveProduct({ env, ctx, user, body, uploadedImageFile }) {
  const pid = body.id || 'PROD-' + crypto.randomUUID();

  let finalCategoryId = null;
  if (body.category_id === 'NEW_CHAIN') {
    const chainNames = JSON.parse(body.category_chain_names || '[]');
    finalCategoryId = await resolveCategoryChain(env, user.user_id, chainNames, body.category_anchor_id || 0);
  } else if (body.category_id) {
    finalCategoryId = parseInt(body.category_id) || null;
  }

  let imageUrl = body.existing_image || null;
  if (uploadedImageFile) {
    imageUrl = await uploadProductImage(env, user.username, pid, uploadedImageFile);
  }

  await env.DB.prepare(
    `INSERT INTO products (id, merchant_id, name, description, price, cost_price, discount, image, quantity, quantity_type, currency, category_id, options, is_available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
     name=excluded.name, description=excluded.description, price=excluded.price, cost_price=excluded.cost_price,
     discount=excluded.discount, image=excluded.image, quantity=excluded.quantity, quantity_type=excluded.quantity_type,
     currency=excluded.currency, category_id=excluded.category_id, options=excluded.options,
     is_available=excluded.is_available, updated_at=excluded.updated_at`
  )
    .bind(
      pid,
      user.user_id,
      body.name,
      body.mainDescription || body.description || '',
      parseFloat(body.price) || 0,
      parseFloat(body.cost_price) || 0,
      parseFloat(body.discount) || 0,
      imageUrl,
      parseInt(body.quantity) || 0,
      body.quantity_type || 'tracked',
      body.currency || 'YER',
      finalCategoryId,
      body.sizes || JSON.stringify(body.options || []),
      body.isAvailable === '0' ? 0 : 1,
      Date.now()
    )
    .run();

  const allProducts = await env.DB.prepare(
    `SELECT * FROM products WHERE merchant_id = ? AND is_available = 1`
  )
    .bind(user.user_id)
    .all();
  ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, allProducts.results));

  return {
    message: 'تم حفظ المنتج بنجاح (وجاري تحديث المتجر للزبائن)',
    product_id: pid,
    image: imageUrl,
  };
}

export async function listProducts({ env, user }) {
  const myProducts = await env.DB.prepare(
    `SELECT * FROM products WHERE merchant_id = ? ORDER BY updated_at DESC`
  )
    .bind(user.user_id)
    .all();

  const data = myProducts.results.map((p) => {
    try {
      p.options = JSON.parse(p.options || '[]');
    } catch (e) {
      p.options = [];
    }
    return p;
  });
  return { data };
}

export async function deleteProduct({ env, ctx, user, body }) {
  const pid = body.id;

  // فحص أمني: هل المنتج ضمن طلب نشط حالياً عند زبون؟
  const statusList = ACTIVE_ORDER_STATUSES.map((s) => `'${s}'`).join(',');
  const activeTicket = await env.DB.prepare(
    `SELECT ticket_id FROM live_tickets
     WHERE merchant_id = ?
     AND status IN (${statusList})
     AND ticket_data LIKE ? LIMIT 1`
  )
    .bind(user.user_id, `%"product_id":"${pid}"%`)
    .first();

  if (activeTicket) {
    throw new HttpError(
      'لا يمكنك حذف هذا المنتج حالياً لأنه ضمن طلب نشط لزبون. أنهِ الطلب أو ألغِه أولاً.',
      409
    );
  }

  await env.DB.prepare(`DELETE FROM products WHERE id = ? AND merchant_id = ?`)
    .bind(pid, user.user_id)
    .run();

  const remainingProducts = await env.DB.prepare(
    `SELECT * FROM products WHERE merchant_id = ? AND is_available = 1`
  )
    .bind(user.user_id)
    .all();
  ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, remainingProducts.results));

  return { message: 'تم حذف المنتج نهائياً بنجاح' };
}

export async function toggleAvailability({ env, ctx, user, body }) {
  const pid = body.id;
  const reqStatus = parseInt(body.isAvailable) ? 1 : 0;

  await env.DB.prepare(
    `UPDATE products SET is_available = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`
  )
    .bind(reqStatus, Date.now(), pid, user.user_id)
    .run();

  const visibleProducts = await env.DB.prepare(
    `SELECT * FROM products WHERE merchant_id = ? AND is_available = 1`
  )
    .bind(user.user_id)
    .all();
  ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, visibleProducts.results));

  return { message: 'تم تحديث حالة عرض المنتج (إخفاء/إظهار) بنجاح' };
}
