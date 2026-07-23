import { commitMultipleFiles } from '../storage/providers/githubProvider.js';
import { purgeCloudflareCache, buildStoreFileUrls } from '../storage/providers/cloudflareCacheProvider.js';

// ========================================================
// 🏪 خدمة مزامنة معلومات المتجر (info.json) إلى GitHub
// نفس نمط catalogSyncService.js، لكن لملف معلومات المتجر
// (اسم المتجر / النوع / الهاتف / الإعدادات العامة) الذي
// تعتمد عليه واجهة المتجر العامة (storefront) لعرض بيانات
// المتجر دون الحاجة لاستدعاء الـ API مباشرة.
// ========================================================

export async function syncStoreInfoToStorefront(env, username, storeInfo) {
  try {
    if (!username) return;

    const timestamp = Date.now();
    const infoData = {
      _version: timestamp,
      data: {
        store_name: storeInfo.store_name || '',
        store_type: storeInfo.store_type || null,
        phone: storeInfo.phone || null,
        settings: storeInfo.settings || {},
      },
    };

    const infoPath = `stores/${username}/info.json`;
    await commitMultipleFiles(
      env,
      [{ path: infoPath, content: JSON.stringify(infoData) }],
      `⚡ Auto-sync store info via Worker [${username}]`
    );

    console.log(`[Store Info Sync Success] ${username}`);

    // 🧹 مسح كاش Cloudflare لرابط معلومات هذا التاجر فقط على دومين واجهة
    // المتجر، حتى تظهر أي تغييرات (اسم المتجر، السياسات، ...) فوراً للزبائن.
    await purgeCloudflareCache(env, buildStoreFileUrls(env, [infoPath]));
  } catch (error) {
    console.error('Store Info Sync Error:', error);
  }
}
