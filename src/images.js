// 본문에 넣을 "관련 사진"을 Pexels 무료 API 로 가져와 HTML 에 끼워 넣는다.
// 사진은 부가 기능이므로, 키가 없거나 검색이 실패해도 글 발행은 절대 막지 않는다(안전 우회).
// 무료 키 발급: https://www.pexels.com/api/  →  .env 의 PEXELS_API_KEY 에 입력.

import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  if (!images.length) return { html: article.html, images: [], thumbnailPath: null };

  // 대표 이미지(첫 장)는 로컬에 내려받아 발행 시 티스토리 서버에 업로드한다.
  // 티스토리는 "자체 서버에 올라온 이미지"에서만 대표이미지(목록 썸네일·og:image)를 잡기 때문에,
  // 외부 링크(Pexels)만 있으면 썸네일이 생기지 않는다. → 1장만 올려서 썸네일을 보장한다.
  // 업로드용으로 빼낸 1장은 본문에서 제외해 같은 사진이 위·아래로 중복되지 않게 한다.
  let thumbnailPath = null;
  let bodyImages = images;
  try {
    thumbnailPath = await downloadToTemp(images[0].url);
    bodyImages = images.slice(1);
  } catch (e) {
    console.warn(`⚠️  대표 이미지 내려받기 실패 — 썸네일 없이 외부 링크로만 진행합니다. (${e.message})`);
  }

  // alt 는 한글(섹션 제목/글 제목) 기준으로 채운다 — 한글 이미지 검색 유입을 위해.
  return { html: insertImages(article.html, bodyImages, article.title || ''), images, thumbnailPath };
}

/** 이미지 URL 을 OS 임시 폴더로 내려받아 로컬 경로를 돌려준다(티스토리 업로드용). */
async function downloadToTemp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const m = String(url).split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
  const ext = (m ? m[1].toLowerCase() : 'jpg').replace('jpeg', 'jpg');
  const file = join(tmpdir(), `tistory-thumb-${Date.now()}.${ext}`);
  writeFileSync(file, buf);
  return file;
}

/** 임시 썸네일 파일을 정리한다(실패해도 무시). */
export function cleanupTemp(path) {
  if (!path) return;
  try { unlinkSync(path); } catch { /* 이미 없거나 잠김 — 무시 */ }
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

/**
 * 사진을 <h2> 섹션마다 그 앞에 하나씩 끼워 넣는다. <h2> 가 없으면 첫 문단 뒤에 모아 넣는다.
 * alt 는 사진이 놓이는 섹션의 <h2> 제목(한글)을 쓰고, 없으면 글 제목(fallbackAlt)으로 채운다.
 */
function insertImages(html, images, fallbackAlt = '') {
  const parts = html.split(/(?=<h2)/i);

  if (parts.length > 1) {
    let out = parts[0];
    let imgIdx = 0;
    for (let i = 1; i < parts.length; i++) {
      if (imgIdx < images.length) {
        // 이 사진은 parts[i] 섹션 바로 앞에 놓이므로, 그 섹션의 <h2> 제목을 alt 로.
        const alt = headingText(parts[i]) || fallbackAlt || images[imgIdx].alt;
        out += figureHtml(images[imgIdx], alt);
        imgIdx++;
      }
      out += parts[i];
    }
    // 섹션보다 사진이 많으면 글 제목을 alt 로 끝에 붙인다.
    for (; imgIdx < images.length; imgIdx++) {
      out += figureHtml(images[imgIdx], fallbackAlt || images[imgIdx].alt);
    }
    return out;
  }

  const blocks = images.map((img) => figureHtml(img, fallbackAlt || img.alt));
  const idx = html.indexOf('</p>');
  if (idx === -1) return blocks.join('\n') + html;
  const cut = idx + '</p>'.length;
  return html.slice(0, cut) + '\n' + blocks.join('\n') + html.slice(cut);
}

/** 섹션 조각 맨 앞의 <h2>제목</h2> 에서 순수 텍스트를 뽑는다(없으면 ''). */
function headingText(part) {
  const m = part.match(/^<h2[^>]*>([\s\S]*?)<\/h2>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

/** Pexels 사진 1장을 <figure> 블록으로. (출처 표기는 의무 아니나 예의상 표기) */
function figureHtml({ url, photographer, photographerUrl }, alt = '') {
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
