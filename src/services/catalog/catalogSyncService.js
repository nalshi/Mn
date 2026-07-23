import { commitMultipleFiles } from '../storage/providers/githubProvider.js';
import { purgeCloudflareCache, buildStoreFileUrls } from '../storage/providers/cloudflareCacheProvider.js';

// ========================================================
// ⚡ خدمة مزامنة كتالوج المتجر (منتجات + فئات) إلى GitHub
// نفس منطق الأصلي بالضبط، بس بمعزل عن باقي الموديولات حتى
// تقدر تطوّر منطق الكتالوج بدون ما تلمس المنتجات أو الطلبات.
// ========================================================

const PAGE_SIZE = 20;

function safeParse(str, fallback) {
  try {
    return JSON.parse(str || JSON.stringify(fallback));
  } catch (e) {
    return fallback;
  }
}

export async function syncCatalogToStorefront(env, username, merchantId, products) {
  try {
    let catRows = [];
    if (merchantId) {
      const catsRes = await env.DB.prepare(
        `SELECT id, name, parent_id FROM categories WHERE user_id = ? OR user_id IS NULL ORDER BY parent_id, name`
      )
        .bind(merchantId)
        .all();
      catRows = catsRes.results || [];
    }

    const catNameById = {};
    catRows.forEach((c) => {
      catNameById[c.id] = c.name;
    });

    const timestamp = Date.now();
    let pages = {};
    let productRef = {};

    for (let i = 0; i < products.length; i += PAGE_SIZE) {
      const chunk = products.slice(i, i + PAGE_SIZE);
      const pageNum = Math.floor(i / PAGE_SIZE) + 1;
      const pageData = {};

      chunk.forEach((p) => {
        const opts = safeParse(p.options, []);
        const feats = safeParse(p.features, []);
        const cid = p.category_id ? parseInt(p.category_id) : null;

        pageData[p.id] = {
          id: p.id,
          name: p.name,
          mainDescription: p.description || '',
          price: parseFloat(p.price) || 0,
          discount: parseFloat(p.discount) || 0,
          image: p.image || '',
          type: catNameById[cid] || 'عام',
          category_id: cid,
          options: opts,
          features: feats,
          quantity: parseInt(p.quantity) || 0,
          quantity_type: p.quantity_type || 'tracked',
          is_available: parseInt(p.is_available) || 1,
          currency: p.currency || 'YER',
        };

        productRef[p.id] = { id: p.id, n: String(p.name).substring(0, 40), pg: pageNum, cid };
      });

      pages[pageNum] = pageData;
    }
    if (Object.keys(pages).length === 0) pages[1] = {};

    const catMap = {};
    catRows.forEach((c) => {
      catMap[c.id] = { id: c.id, name: c.name, parent_id: c.parent_id || 0, products: [], children: [] };
    });
    Object.values(productRef).forEach((ref) => {
      if (ref.cid && catMap[ref.cid]) {
        catMap[ref.cid].products.push({ id: ref.id, n: ref.n, pg: ref.pg });
      }
    });
    const catRoots = [];
    Object.values(catMap).forEach((node) => {
      if (node.parent_id && catMap[node.parent_id]) {
        catMap[node.parent_id].children.push(node);
      } else {
        catRoots.push(node);
      }
    });

    const categoriesData = { _version: timestamp, data: catRoots };
    const searchIndex = {
      _version: timestamp,
      data: Object.values(productRef).map((r) => ({ id: r.id, n: r.n, pg: r.pg })),
    };

    const pageNums = Object.keys(pages);
    const manifestVersions = { search: timestamp, categories: timestamp, info: timestamp, pages: {} };

    const files = [
      { path: `stores/${username}/search_index.json`, content: JSON.stringify(searchIndex) },
      { path: `stores/${username}/categories.json`, content: JSON.stringify(categoriesData) },
    ];

    pageNums.forEach((pageNum) => {
      files.push({
        path: `stores/${username}/products_page_${pageNum}.json`,
        content: JSON.stringify({
          _version: timestamp,
          page: parseInt(pageNum),
          total_pages: pageNums.length,
          data: pages[pageNum],
        }),
      });
      manifestVersions.pages[`page_${pageNum}`] = timestamp;
    });

    files.push({
      path: `stores/${username}/manifest.json`,
      content: JSON.stringify({
        version: timestamp,
        total_products: products.length,
        total_pages: pageNums.length,
        files: manifestVersions,
      }),
    });

    await commitMultipleFiles(env, files, `⚡ Auto-sync via Worker [${username}]`);
    console.log(`[Catalog Sync Success] ${username}`);

    // 🧹 مسح كاش Cloudflare لروابط هذا التاجر فقط على دومين واجهة المتجر
    // (الدومين الموجود في Cloudflare) حتى تنعكس التحديثات فوراً بدل انتظار
    // انتهاء صلاحية الكاش الطبيعية.
    const cacheUrls = buildStoreFileUrls(
      env,
      files.map((f) => f.path)
    );
    await purgeCloudflareCache(env, cacheUrls);
  } catch (error) {
    console.error('Catalog Sync Error:', error);
  }
}
