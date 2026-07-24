// ========================================================
// ☁️ مزود مسح الكاش: Cloudflare Cache Purge
// طبقة منخفضة المستوى فقط (بنفس روح githubProvider.js): تستقبل
// روابط ملفات واجهة المتجر وتطلب من Cloudflare مسح الكاش الخاص
// بها تحديداً، على "الدومين الموجود في Cloudflare" فقط (Zone واحد
// محدد عبر CLOUDFLARE_ZONE_ID) — لا علاقة له بروابط GitHub/jsdelivr
// نفسها، فقط الدومين المخصص لواجهة المتجر الذي يمر عبر Cloudflare.
//
// ⚙️ متغيرات بيئة مطلوبة (secrets/vars على الـ Worker):
//   - CLOUDFLARE_API_TOKEN  : توكن بصلاحية "Cache Purge" على الـ Zone فقط
//   - CLOUDFLARE_ZONE_ID    : معرّف الـ Zone الخاص بدومين واجهة المتجر
//   - STOREFRONT_BASE_URL   : رابط واجهة المتجر العام (مثال: https://store.example.com)
// إذا لم تكن مُهيأة، الدالة تتجاهل العملية بصمت (نفس نمط باقي
// المزامنات الخلفية بالمشروع) حتى لا تكسر مزامنة GitHub الأساسية.
// ========================================================

const CF_API = 'https://api.cloudflare.com/client/v4';
const MAX_URLS_PER_REQUEST = 30; // حد Cloudflare لمسح الكاش "برابط ملف واحد"

export async function purgeCloudflareCache(env, urls) {
  try {
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
      console.warn('Cloudflare Cache Purge skipped: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID missing');
      return;
    }

    const files = [...new Set((urls || []).filter(Boolean))];
    if (!files.length) {
      console.warn('Cloudflare Cache Purge skipped: no URLs to purge (check STOREFRONT_BASE_URL)');
      return;
    }

    for (let i = 0; i < files.length; i += MAX_URLS_PER_REQUEST) {
      const chunk = files.slice(i, i + MAX_URLS_PER_REQUEST);
      const res = await fetch(`${CF_API}/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: chunk }),
      });
      if (!res.ok) {
        console.error('Cloudflare Cache Purge failed:', await res.text());
      } else {
        console.log('Cloudflare Cache Purge success:', chunk.length, 'file(s):', chunk.join(', '));
      }
    }
  } catch (error) {
    console.error('Cloudflare Cache Purge Error:', error);
  }
}

// يبني روابط ملفات متجر تاجر معيّن على دومين واجهة المتجر (STOREFRONT_BASE_URL)
// حتى نمسح فقط روابط هذا التاجر تحديداً (وليس كل الدومين).
export function buildStoreFileUrls(env, paths) {
  const base = (env.STOREFRONT_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return [];
  return (paths || []).map((p) => `${base}/${String(p).replace(/^\/+/, '')}`);
}
