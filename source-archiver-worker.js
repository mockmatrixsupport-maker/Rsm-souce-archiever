/* source-archiver-worker.js

   GET  /check-source?family=&examId=&date=&shift=&lang=
        -> { exists: true|false }
        Lightweight. No HTML involved. Client calls this FIRST, every time.

   POST /commit-source
        Body: {
          family, examId, date, shift, lang,
          sourceUrl: string,               // URL the user's HTML was fetched from
          parts: [{ name: 'part1', html: '...' }, ...]
        }
        Client only calls this if /check-source said exists:false.
        Re-checks KV internally too (race safety, see note below).

   KV binding: SRC_KV
   Secrets:    GH_TOKEN (fine-grained PAT, contents:read+write on target repo)
   Vars:       GH_OWNER, GH_REPO, GH_BRANCH (optional, defaults to 'main')
*/

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/check-source') {
      return handleCheck(url, env);
    }
    if (request.method === 'POST' && url.pathname === '/commit-source') {
      return handleCommit(request, env);
    }
    return json({ error: 'not found' }, 404);
  }
};

// ── GET /check-source — cheap, KV-only, no GitHub call, no HTML ──────
async function handleCheck(url, env) {
  const family = url.searchParams.get('family');
  const examId = url.searchParams.get('examId');
  const date = url.searchParams.get('date');
  const shift = url.searchParams.get('shift');
  const lang = url.searchParams.get('lang');

  if (!family || !examId || !shift || !lang) {
    return json({ error: 'missing family/examId/shift/lang' }, 400);
  }

  const existing = await env.SRC_KV.get(kvKey(family, examId, date, shift, lang));
  return json({ exists: !!existing }, 200);
}

// ── POST /commit-source — only called when check-source said false ──
async function handleCommit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad json' }, 400);
  }

  const { family, examId, date, shift, lang, sourceUrl, parts } = body;
  if (!family || !examId || !shift || !lang || !Array.isArray(parts) || !parts.length) {
    return json({ error: 'missing family/examId/shift/lang/parts' }, 400);
  }

  const key = kvKey(family, examId, date, shift, lang);

  // Re-check here too: the client's earlier /check-source and this call
  // are two separate round-trips, so another user could have committed
  // in between. This second gate is what actually prevents the GitHub
  // write, not the client-side check (that's only there to save the
  // user's upload bandwidth, not to be the source of truth).
  const existing = await env.SRC_KV.get(key);
  if (existing) {
    return json({ status: 'exists' }, 200);
  }

  try {
    const folder = `source-html/${family}/${examId}/${date || 'na'}/${shift}/${lang}`;

    for (const part of parts) {
      const safeName = String(part.name || 'part').replace(/[^a-zA-Z0-9_-]/g, '_');
      await commitFile(env, `${folder}/${safeName}.html`, part.html);
    }

    // Plain text file recording where this HTML came from.
    if (sourceUrl) {
      await commitFile(env, `${folder}/source-url.txt`, sourceUrl);
    }

    await env.SRC_KV.put(key, JSON.stringify({ committedAt: Date.now(), parts: parts.length }));
    return json({ status: 'committed', count: parts.length }, 200);
  } catch (e) {
    return json({ status: 'error', message: String(e && e.message || e) }, 500);
  }
}

function kvKey(family, examId, date, shift, lang) {
  return `srchtml:${family}:${examId}:${date || 'na'}:${shift}:${lang}`;
}

async function commitFile(env, path, textContent) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GH_TOKEN}`,
      'User-Agent': 'rsm-source-archiver',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Archive: ${path}`,
      content: toBase64(textContent),
      branch: env.GH_BRANCH || 'main'
    })
  });

  if (!res.ok) {
    // 422 with no sha = file already exists at that path (rare parallel
    // duplicate slipping past both KV checks). Treat as success.
    if (res.status === 422) return;
    throw new Error(`GitHub commit failed ${res.status}: ${await res.text()}`);
  }
}

// UTF-8 safe base64 (plain btoa breaks on non-ASCII, e.g. Hindi text).
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
