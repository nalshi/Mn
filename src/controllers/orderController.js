import { syncOrderTracking } from '../services/realtime/realtimeSyncService.js';
import { notifyOrderStatusUpdate } from '../services/notifications/notificationService.js';

// ========================================================
// 📦 تحكم طلبات التاجر
// ========================================================

// 📦 الطلبات النشطة (live_tickets) فقط - نفس شكل بيانات get_orders('active') في api.php
// تماماً، حتى تعرض لوحة التاجر الطلبات بغض النظر عن مصدرها (Worker أو السيرفر القديم).
// ⚠️ الطلبات المؤرشفة (orders_archive/sales_log) ما زالت على TiDB فقط ولم تُنقل هنا.
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

export async function updateOrderStatus({ env, ctx, user, body }) {
  await env.DB.prepare(`UPDATE live_tickets SET status = ? WHERE ticket_id = ? AND merchant_id = ?`)
    .bind(body.status, body.ticket_id, user.user_id)
    .run();

  const order = await env.DB.prepare(
    `SELECT * FROM live_tickets WHERE ticket_id = ? AND merchant_id = ?`
  )
    .bind(body.ticket_id, user.user_id)
    .first();

  if (order) {
    ctx.waitUntil(syncOrderTracking(env, body.ticket_id, body.status, user.username));
    ctx.waitUntil(notifyOrderStatusUpdate(env, order.customer_id, body.status, body.ticket_id));
  }

  return { message: 'تم تحديث حالة الطلب' };
}
