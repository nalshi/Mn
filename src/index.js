import { actionRegistry } from './router.js';
import { verifyJWT } from './security/auth.js';
import { assertAllowed, HttpError } from './security/rbac.js';
import { validateAction } from './security/validate.js';
import { buildCorsHeaders, successResponse, errorResponse } from './core/response.js';

// ========================================================
// 🚪 نقطة الدخول الرئيسية للـ Worker
// هذا الملف تنسيقي فقط: يحلل الطلب، يتحقق من الهوية
// والصلاحية والمدخلات، ثم يفوّض التنفيذ للـ controller المناسب
// عبر جدول الأفعال (router.js). لا يوجد منطق عمل هنا إطلاقاً.
// ========================================================
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET') {
      return successResponse({ message: 'API Worker is running' }, corsHeaders);
    }

    try {
      const { body, uploadedImageFile } = await parseRequestBody(request);
      const action = body.action;

      const route = actionRegistry[action];
      if (!route) {
        return errorResponse('Action غير معروف', corsHeaders, 400);
      }

      // --- المصادقة ---
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      const user = token ? await verifyJWT(token, env.APP_SECRET_KEY) : null;

      if (!route.public && !user) {
        return errorResponse('غير مصرح', corsHeaders, 401);
      }

      // --- الصلاحيات (RBAC) ---
      assertAllowed(user, route.roles);

      // --- التحقق من المدخلات ---
      validateAction(action, body, user);

      // --- التنفيذ ---
      const result = await route.handler({ request, env, ctx, user, body, uploadedImageFile });
      return successResponse(result || {}, corsHeaders);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return errorResponse(error.message || 'حدث خطأ في السيرفر', corsHeaders, status);
    }
  },
};

async function parseRequestBody(request) {
  let body = {};
  let uploadedImageFile = null;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    // طلبات فيها ملف صورة (FormData) — تأتي من فورم حفظ المنتج
    const formData = await request.formData();
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        if (key === 'image_file' && value.size > 0) uploadedImageFile = value;
      } else {
        body[key] = value;
      }
    }
  } else {
    body = await request.json();
  }
  return { body, uploadedImageFile };
}
