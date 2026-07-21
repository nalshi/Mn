// ========================================================
// 🔄 مزامنة إعدادات التاجر مع النظام القديم (api.php / TiDB)
// موجودة كموديول مستقل حتى تقدر تحذفها بسهولة يوم يصير
// الانتقال الكامل لـ D1 بدون أي اعتماد على api.php
// ========================================================

export async function syncMerchantSettingsToLegacyApi(env, merchantId, storeName, storeType, settingsJson) {
  try {
    if (!env.API_PHP_URL || !env.INTERNAL_SYNC_KEY) return;
    await fetch(env.API_PHP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.INTERNAL_SYNC_KEY },
      body: JSON.stringify({
        action: 'worker_sync_settings',
        id: merchantId,
        store_name: storeName,
        store_type: storeType,
        settings: settingsJson,
      }),
    });
  } catch (e) {
    console.error('TiDB write-through failed:', e);
  }
}
