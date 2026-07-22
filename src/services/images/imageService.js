import { putSingleFile } from '../storage/providers/githubProvider.js';
import { arrayBufferToBase64 } from '../../core/encoding.js';

// ========================================================
// 🖼️ خدمة صور المنتجات
// منطق العمل هنا فقط (بناء المسار، تحويل الصورة).
// التخزين الفعلي مفوّض لمزود التخزين (githubProvider) —
// لو تغيّر المزود مستقبلاً، هذا الملف ما يتغيّر إطلاقاً.
// ========================================================
export async function uploadProductImage(env, username, productId, imageFile) {
  const buffer = await imageFile.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const path = `images/${username}/${productId}.webp`;
  return putSingleFile(env, path, base64, `🖼️ Product image [${username}/${productId}]`);
}
