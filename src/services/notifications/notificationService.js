import { sendFcmNotification } from './providers/fcmProvider.js';

// ========================================================
// 🔔 خدمة الإشعارات - منطق العمل فقط
// ========================================================

export async function notifyOrderStatusUpdate(env, customerId, status, ticketId) {
  const customer = await env.DB.prepare(`SELECT fcm_token FROM users WHERE id = ?`)
    .bind(customerId)
    .first();

  if (customer && customer.fcm_token) {
    await sendFcmNotification(
      env,
      customer.fcm_token,
      'تحديث حالة طلبك 📦',
      `تم تحديث حالة طلبك إلى: ${status}`,
      { action: 'order_status_update', ticket_id: ticketId }
    );
  }
}
