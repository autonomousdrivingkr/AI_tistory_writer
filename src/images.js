// 본문에 넣을 "관련 사진"을 Pexels 무료 API 로 가져와 HTML 에 끼워 넣는다.
// 사진은 부가 기능이므로, 키가 없거나 검색이 실패해도 글 발행은 절대 막지 않는다(안전 우회).
// 무료 키 발급: https://www.pexels.com/api/  →  .env 의 PEXELS_API_KEY 에 입력.

const PEXELS_ENDPOINT = 'https://api.pexels.com/v1/search';

/**
 * 글에 관련 사진을 붙인 새 HTML 을 돌려준다.
 * @param {{html:string, imageQueries?:string[], tags?:string[], title?:string}} article
 * @param {object} config
 * @returns {Promise<{html:string, images:Array<object>}>}
 */
export async function attachImages(article, config) {
  const imgCfg = config.images || {};
  if (!imgCfg.enabled) return { html: article.html, images: [] };

  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  PEXELS_API_KEY 가 없어 사진 없이 진행합니다. (.env 확인 — https://www.pexels.com/api/)');
    return { html: article.html, images: [] };
  }

  const want = imgCfg.perArticle || 3;
  const queries = pickQueries(article, want);
  if (!queries.length) return { html: article.html, images: [] };

  let images = [];
  try {
    images = await fetchImages(queries, {
      apiKey,
      orientation: imgCfg.orientation || 'landscape',
      limit: want
    });
  } catch (e) {
    console.warn(`⚠️  사진 가져오기 실패 — 사진 없이 진행합니다. (${e.message})`);
    return { html: article.html, images: [] };
  }

  if (!images.length) return { html: article.html, images: [] };
  return { html: insertImages(article.html, images), images };
}

/** 사진 검색어를 고른다: 모델이 준 영어 키워드 우선, 없으면 태그/제목으로 폴백. */
function pickQueries(article, want) {
  const clean = (arr) => (arr || []).map((s) => String(s).trim()).filter(Boolean);
  const fromModel = clean(article.imageQueries);
  const fromTags = clean(article.tags);
  const pool = fromModel.length ? fromModel : fromTags.length ? fromTags : clean([article.title]);
  return [...new Set(pool)].slice(0, want);
}

/** 검색어마다 사진 1장씩(중복 제외) 모아 최대 limit 장을 돌려준다. */
async function fetchImages(queries, { apiKey, orientation, limit }) {
  const seen = new Set();
  const picked = [];
  const perPage = Math.max(5, limit + 2);

  for (const q of queries) {
    if (picked.length >= limit) break;
    const url = new URL(PEXELS_ENDPOINT);
    url.searchParams.set('query', q);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('orientation', orientation);

    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) {
      // 401: 키 오류(다음 쿼리도 실패하므로 즉시 중단), 그 외(429 등): 이 쿼리만 건너뜀
      if (res.status === 401) throw new Error('Pexels API 키가 올바르지 않습니다 (401).');
      console.warn(`⚠️  Pexels 검색 실패(${res.status}): "${q}"`);
      continue;
    }

    const data = await res.json();
    const photo = (data.photos || []).find((p) => !seen.has(p.id));
    if (!photo) continue;
    seen.add(photo.id);
    picked.push({
      url: photo.src?.large || photo.src?.medium || photo.src?.original,
      alt: photo.alt || q,
      photographer: photo.photographer || '',
      photographerUrl: photo.photographer_url || '',
      query: q
    });
  }
  return picked;
}

/** 사진을 <h2> 섹션마다 그 앞에 하나씩 끼워 넣는다. <h2> 가 없으면 첫 문단 뒤에 모아 넣는다. */
function insertImages(html, images) {
  const blocks = images.map(figureHtml);
  const parts = html.split(/(?=<h2)/i);

  if (parts.length > 1) {
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
      if (blocks.length) out += blocks.shift();
      out += parts[i];
    }
    if (blocks.length) out += blocks.join('\n'); // 섹션보다 사진이 많으면 끝에 붙인다
    return out;
  }

  const idx = html.indexOf('</p>');
  if (idx === -1) return blocks.join('\n') + html;
  const cut = idx + '</p>'.length;
  return html.slice(0, cut) + '\n' + blocks.join('\n') + html.slice(cut);
}

/** Pexels 사진 1장을 <figure> 블록으로. (출처 표기는 의무 아니나 예의상 표기) */
function figureHtml({ url, alt, photographer, photographerUrl }) {
  const credit = photographer
    ? `<figcaption>사진: <a href="${escapeHtml(photographerUrl)}" target="_blank" rel="noopener">${escapeHtml(photographer)}</a> / Pexels</figcaption>`
    : '';
  return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">${credit}</figure>\n`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
