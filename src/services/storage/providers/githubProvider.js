// ========================================================
// 🐙 مزود التخزين: GitHub (Storage Provider)
// طبقة منخفضة المستوى فقط: "ارفع ملف" أو "اعمل كوميت لعدة ملفات".
// لا تعرف شيء عن صور أو منتجات أو كتالوج - هذا مقصود، حتى لو
// تغيّر مزود التخزين لاحقاً (R2 / S3) نلمس هذا الملف فقط.
// ========================================================

const GITHUB_API = 'https://api.github.com';

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Cloudflare-Worker',
  };
}

// رفع/تحديث ملف واحد عبر Contents API (مناسب للصور)
export async function putSingleFile(env, path, base64Content, commitMessage) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  const headers = githubHeaders(env);

  let sha;
  const existing = await fetch(url, { headers });
  if (existing.ok) {
    sha = (await existing.json()).sha;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message: commitMessage, content: base64Content, sha }),
  });
  if (!res.ok) throw new Error('فشل رفع الملف إلى GitHub: ' + (await res.text()));

  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/${path}`;
}

// كوميت واحد ذرّي لعدة ملفات دفعة واحدة عبر Git Trees API (مناسب لكتالوج المتجر)
export async function commitMultipleFiles(env, files, commitMessage) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const apiBase = `${GITHUB_API}/repos/${owner}/${repo}`;
  const headers = githubHeaders(env);

  const refRes = await fetch(`${apiBase}/git/ref/heads/main`, { headers }).then((r) => r.json());
  const latestCommitSha = refRes.object.sha;

  const commitRes = await fetch(`${apiBase}/git/commits/${latestCommitSha}`, { headers }).then((r) =>
    r.json()
  );
  const baseTreeSha = commitRes.tree.sha;

  const treeRes = await fetch(`${apiBase}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }),
  }).then((r) => r.json());

  const newCommitRes = await fetch(`${apiBase}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: commitMessage, tree: treeRes.sha, parents: [latestCommitSha] }),
  }).then((r) => r.json());

  await fetch(`${apiBase}/git/refs/heads/main`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommitRes.sha }),
  });
}
