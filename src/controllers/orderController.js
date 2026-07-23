import { syncOrderTracking } from '../services/realtime/realtimeSyncService.js';
import {
  notifyOrderStatusUpdate,
  notifyMerchantOrderUpdate,
  notifyOrderCompleted,
} from '../services/notifications/notificationService.js';
import { HttpError } from '../security/rbac.js';
import { syncCatalogToStorefront } from '../services/catalog/catalogSyncService.js';

// ========================================================
// 📦 تحكم طلبات التاجر - دورة حياة الطلب كاملة على D1
// ========================================================

// 📦 طلبات نشطة (live_tickets) + مؤرشفة (orders_archive) - كلها من D1 الآن.
export async function getOrders({ env, user, body }) {
  const filter = body?.filter === 'archived' ? 'archived' : 'active';

  if (filter === 'active') {
    return getMerchantOrders({ env, user });
  }

  const archives = await env.DB.prepare(
    `SELECT ticket_id as id, final_status as status, archived_at as created_at, archived_data, total_amount
     FROM orders_archive WHERE merchant_id = ? ORDER BY archived_at DESC`
  )
    .bind(user.user_id)
    .all();

  const orders = (archives.results || []).map((arc) => {
    let data = {};
    try {
      data = JSON.parse(arc.archived_data || '{}');
    } catch (e) {
      data = {};
    }
    const cust = data.customer || {};
    return {
      id: arc.id,
      total_amount: arc.total_amount,
      status: arc.status,
      created_at: arc.created_at,
      customer_name: cust.name || 'عميل',
      items: data.items || [],
    };
  });

  return { data: orders };
}

// 📦 الطلبات النشطة (live_tickets) فقط
export async function getMerchantOrders({ env, user }) {
  const tickets = await env.DB.prepare(
    `SELECT ticket_id as id, order_group_id, status, created_at, delivery_code, delivery_agent_id, ticket_data
     FROM live_tickets WHERE merchant_id = ? ORDER BY created_at DESC`
  )
    .bind(user.user_id)
    .all();

  const orders = (tickets.results || []).map((t) => {
    let data = {};
    try {
      data = JSON.parse(t.ticket_data || '{}');
    } catch (e) {
      data = {};
    }
    if (!data || typeof data !== 'object') data = {};

    const fin = data.financials || {};
    const cust = data.customer || {};

    return {
      id: t.id,
      order_group_id: t.order_group_id,
      total_amount: fin.grand_total ?? 0,
      currency: fin.currency || 'YER',
      delivery_fee: fin.delivery_fee ?? 0,
      delivery_address_text: cust.address_text || 'عنوان غير محدد',
      delivery_gps_link: cust.gps_link || '',
      status: t.status,
      created_at: t.created_at,
      delivery_code: t.delivery_code || '',
      customer_name: cust.name || 'عميل',
      customer_phone: cust.phone || '',
      items: data.items || [],
      is_agent_assigned: t.delivery_agent_id !== null && t.delivery_agent_id !== undefined,
    };
  });

  return { data: orders };
}

// ✅ تحديث حالة عامة (موافقة التاجر، خرج للتوصيل، ...) - يغطي merchant_approve_order
// و merchant_update_order_status القديمتين معاً بأكشن واحد موحّد.
export async function updateOrderStatus({ env, ctx, user, body }) {
  if (!body.ticket_id || !body.status) throw new HttpError('ticket_id و status مطلوبان', 400);

  const result = await env.DB.prepare(`UPDATE live_tickets SET status = ? WHERE ticket_id = ? AND merchant_id = ?`)
    .bind(body.status, body.ticket_id, user.user_id)
    .run();

  if (!result.meta || result.meta.changes === 0) {
    throw new HttpError('الطلب غير موجود أو لا يخصك.', 404);
  }

  const order = await env.DB.prepare(
    `SELECT * FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(body.ticket_id, user.user_id)
    .first();

  if (order) {
    ctx.waitUntil(syncOrderTracking(env, body.ticket_id, body.status, user.username));
    // ⭐ إشعار صحيح للعميل (من جدول customers) وللتاجر (من جدول users) معاً
    // عند تغيير التاجر لحالة الطلب.
    ctx.waitUntil(notifyOrderStatusUpdate(env, order.customer_id, body.status, body.ticket_id));
    ctx.waitUntil(notifyMerchantOrderUpdate(env, user.user_id, body.status, body.ticket_id));
  }

  return { message: 'تم تحديث حالة الطلب' };
}

// ❌ إلغاء الطلب - يعيد المخزون المحجوز (للمنتجات المتتبَّعة) ويحذف التذكرة.
export async function cancelOrder({ env, ctx, user, body }) {
  if (!body.ticket_id) throw new HttpError('ticket_id مطلوب', 400);

  const ticket = await env.DB.prepare(
    `SELECT ticket_id, ticket_data, status, customer_id FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(body.ticket_id, user.user_id)
    .first();

  if (!ticket) throw new HttpError('الطلب غير موجود أو تم التعامل معه مسبقاً.', 404);

  let ticketData = {};
  try {
    ticketData = JSON.parse(ticket.ticket_data || '{}');
  } catch (e) {
    ticketData = {};
  }
  const items = ticketData.items || [];
  let inventoryChanged = false;

  for (const item of items) {
    const prod = await env.DB.prepare(`SELECT quantity, quantity_type, options FROM products WHERE id = ? AND merchant_id = ?`)
      .bind(item.product_id, user.user_id)
      .first();

    if (prod && prod.quantity_type === 'tracked') {
      inventoryChanged = true;
      if (item.size_id) {
        let options = [];
        try {
          options = JSON.parse(prod.options || '[]');
        } catch (e) {
          options = [];
        }
        let totalRemaining = 0;
        for (const opt of options) {
          if (opt.id === item.size_id) {
            opt.quantity = (parseInt(opt.quantity, 10) || 0) + item.quantity;
          }
          totalRemaining += parseInt(opt.quantity, 10) || 0;
        }
        await env.DB.prepare(`UPDATE products SET quantity = ?, options = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`)
          .bind(totalRemaining, JSON.stringify(options), Date.now(), item.product_id, user.user_id)
          .run();
      } else {
        await env.DB.prepare(`UPDATE products SET quantity = quantity + ?, updated_at = ? WHERE id = ? AND merchant_id = ?`)
          .bind(item.quantity, Date.now(), item.product_id, user.user_id)
          .run();
      }
    }
  }

  await env.DB.prepare(`DELETE FROM live_tickets WHERE ticket_id = ?`).bind(body.ticket_id).run();

  ctx.waitUntil(syncOrderTracking(env, body.ticket_id, 'cancelled', user.username));
  // ⭐ إلغاء الطلب هو أيضاً "تغيير حالة من قبل التاجر"، فيجب أن يصل إشعار للعميل.
  ctx.waitUntil(notifyOrderStatusUpdate(env, ticket.customer_id, 'cancelled', body.ticket_id));
  if (inventoryChanged) {
    const allProducts = await env.DB.prepare(`SELECT * FROM products WHERE merchant_id = ?`).bind(user.user_id).all();
    ctx.waitUntil(syncCatalogToStorefront(env, user.username, user.user_id, allProducts.results));
  }

  return { message: 'تم إلغاء الطلب بنجاح وإعادة المنتجات للمخزون.' };
}

// ✅ تأكيد التسليم عبر الكود - يسجل المبيعات، يؤرشف الطلب، ويحذف التذكرة النشطة.
export async function confirmDeliveryCode({ env, ctx, user, body }) {
  const ticketId = body.ticket_id;
  const code = String(body.code || '');
  if (!ticketId || code.length !== 4) throw new HttpError('يرجى إدخال الكود المكون من 4 أرقام.', 400);

  const ticket = await env.DB.prepare(
    `SELECT delivery_code, status, ticket_data, customer_id, order_group_id FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(ticketId, user.user_id)
    .first();

  if (!ticket) throw new HttpError('الطلب غير موجود أو تم تسليمه مسبقاً.', 404);
  if (ticket.status !== 'out_for_delivery') throw new HttpError("يجب أن يكون الطلب في حالة 'خرج للتوصيل' أولاً.", 400);
  if (String(ticket.delivery_code) !== code) throw new HttpError('كود التسليم غير صحيح. يرجى المراجعة مع العميل.', 400);

  let ticketData = {};
  try {
    ticketData = JSON.parse(ticket.ticket_data || '{}');
  } catch (e) {
    ticketData = {};
  }
  const items = ticketData.items || [];
  const currency = ticketData.financials?.currency || 'YER';
  const grandTotal = ticketData.financials?.grand_total || 0;

  for (const item of items) {
    const saleId = 'SALE-' + crypto.randomUUID();
    const totalPrice = item.price * item.quantity;
    const costAtSale = (item.cost_price || 0) * item.quantity;
    await env.DB.prepare(
      `INSERT INTO sales_log (id, user_id, product_id, size_id, quantity, price_per_item, total_price, currency, type, cost_at_sale, order_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sale', ?, ?, ?)`
    )
      .bind(saleId, user.user_id, item.product_id, item.size_id || null, item.quantity, item.price, totalPrice, currency, costAtSale, ticketId, Date.now())
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO orders_archive (ticket_id, order_group_id, customer_id, merchant_id, final_status, total_amount, archived_data, archived_at)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`
  )
    .bind(ticketId, ticket.order_group_id, ticket.customer_id, user.user_id, grandTotal, JSON.stringify(ticketData), Date.now())
    .run();

  await env.DB.prepare(`DELETE FROM live_tickets WHERE ticket_id = ?`).bind(ticketId).run();

  ctx.waitUntil(syncOrderTracking(env, ticketId, 'completed', user.username));
  // ⭐ عند اتمام الطلب فعلياً، يصل إشعار صحيح للعميل (تم التسليم) وللتاجر
  // (توثيق المبلغ في رصيده) معاً.
  ctx.waitUntil(
    notifyOrderCompleted(env, {
      customerId: ticket.customer_id,
      merchantId: user.user_id,
      ticketId,
      grandTotal,
      currency,
    })
  );

  return { message: 'تم تأكيد التسليم بنجاح وتوثيق الأرباح في رصيدك!' };
}
