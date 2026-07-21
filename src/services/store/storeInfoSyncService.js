import { commitMultipleFiles } from '../storage/providers/githubProvider.js';

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

    await commitMultipleFiles(
      env,
      [{ path: `stores/${username}/info.json`, content: JSON.stringify(infoData) }],
      `⚡ Auto-sync store info via Worker [${username}]`
    );

    console.log(`[Store Info Sync Success] ${username}`);
  } catch (error) {
    console.error('Store Info Sync Error:', error);
  }
}
