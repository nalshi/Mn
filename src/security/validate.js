import { HttpError } from './rbac.js';

// ========================================================
// ✅ التحقق من صحة المدخلات (Validation) - مركزي لكل action
// أي حقل مطلوب لأكشن جديد يُضاف هنا فقط، بدل ما يتكرر
// التحقق يدوياً جوا كل دالة تحكم.
// ========================================================

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new HttpError(`الحقل "${field}" مطلوب`, 400);
    }
  }
}

const rules = {
  save_product: (body) => requireFields(body, ['name', 'price']),
  delete_product: (body) => requireFields(body, ['id']),
  toggle_availability: (body) => requireFields(body, ['id']),
  update_order_status: (body) => requireFields(body, ['ticket_id', 'status']),
  cancel_order: (body) => requireFields(body, ['ticket_id']),
  confirm_delivery_code: (body) => requireFields(body, ['ticket_id', 'code']),
  // ⭐ تصحيح (2026-07-21): القاعدة القديمة (['merchant_id','order_data']) كانت
  // تطابق شكل بيانات مختلف تماماً عن الحمولة الفعلية التي يرسلها checkout.js
  // (window.apiRequest('create_order', {customer, idempotency_key, local_cart})).
  // لو تُركت كما كانت، كل طلب حقيقي كان سيُرفض فوراً بخطأ "الحقل merchant_id مطلوب".
  create_order: (body) => requireFields(body, ['local_cart']),
  verify_cart_live: (body) => requireFields(body, ['items']),
  add_to_cart: (body) => requireFields(body, ['product_id', 'merchant_id']),
  save_merchant_settings: (body) => requireFields(body, ['storeName']),
  get_public_products: (body, user) => {
    if (!body.username && !user?.username) {
      throw new HttpError('اسم المتجر مطلوب', 400);
    }
  },
};

export function validateAction(action, body, user) {
  const rule = rules[action];
  if (rule) rule(body, user);
}
