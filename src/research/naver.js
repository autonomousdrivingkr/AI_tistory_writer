// 리서치 provider ②: 네이버 검색 API (지역 + 블로그).
// LLM 을 거치지 않고 REST 로 실제 검색 결과(실존 업체명·주소·후기)를 가져와
// "참고 자료 브리핑" 텍스트 + 출처 목록으로 정리한다.
// 맛집·카페·여행처럼 "지역·실존 업체" 주제에서 Gemini 보다 정확도가 높다.
// 무료 키 발급: https://developers.naver.com/  →  .env 의 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET.

const LOCAL_ENDPOINT = 'https://openapi.naver.com/v1/search/local.json';
const BLOG_ENDPOINT = 'https://openapi.naver.com/v1/search/blog.json';

/**
 * @param {{topic:string, instructions?:string, config:object}} args
 * @returns {Promise<{briefing:string, sources:Array<{title:string,url:string}>, provider:'naver'}|null>}
 */
export async function researchWithNaver({ topic, instructions, config }) {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return null;

  const rc = config.research || {};
  const headers = { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret };
  const query = buildQuery(topic, instructions);

  // 지역 검색(실존 업체명·주소)과 블로그 검색(후기)을 동시에. 한쪽이 실패해도 다른 쪽은 살린다.
  const [local, blog] = await Promise.all([
    fetchNaver(LOCAL_ENDPOINT, query, 5, headers).catch((e) => rethrowAuth(e)),
    fetchNaver(BLOG_ENDPOINT, query, 5, headers).catch((e) => rethrowAuth(e))
  ]);

  if (!local.length && !blog.length) return null;

  const briefing = buildBriefing(local, blog);
  const sources = buildSources(blog, local, rc.maxSources || 5);
  const places = buildPlaces(local);
  return { briefing, sources, places, provider: 'naver' };
}

/** 검색어: 주제를 그대로 쓰되, 앞뒤 공백/기호만 정리. */
function buildQuery(topic, instructions) {
  return String(topic || '').trim();
}

async function fetchNaver(endpoint, query, display, headers) {
  const url = new URL(endpoint);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 401) throw new Error('네이버 API 키가 올바르지 않습니다 (401).');
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.items || [];
}

// 401(키 오류)은 두 요청 모두 같은 원인이므로 위로 던져 명확히 실패시키고,
// 그 외 일시적 오류는 빈 배열로 삼켜 나머지 결과라도 살린다.
function rethrowAuth(e) {
  if (/\(401\)/.test(e.message)) throw e;
  return [];
}

/** 지역·블로그 결과를 사람이 읽는 근거 자료 텍스트로 정리한다. */
function buildBriefing(local, blog) {
  const parts = [];

  if (local.length) {
    const lines = local.map((it) => {
      const name = stripTags(it.title);
      const cat = stripTags(it.category);
      const addr = stripTags(it.roadAddress || it.address);
      const tel = stripTags(it.telephone);
      let line = `- ${name}`;
      if (cat) line += ` (${cat})`;
      if (addr) line += ` — ${addr}`;
      if (tel) line += ` / ${tel}`;
      return line;
    });
    parts.push('실존 업체(네이버 지역검색):\n' + lines.join('\n'));
  }

  if (blog.length) {
    const lines = blog.map((it) => {
      const title = stripTags(it.title);
      const desc = stripTags(it.description);
      return `- ${title}${desc ? `: ${desc}` : ''}`;
    });
    parts.push('블로그 후기 요약(네이버 블로그검색):\n' + lines.join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * 본문 끝에 붙일 출처 링크용. 블로그(영구 URL) 우선, 지역검색 링크로 보충.
 * 네이버 URL 은 영구적이라 permanent:true — 본문에 출처 링크로 노출해도 안전하다.
 */
function buildSources(blog, local, limit) {
  const seen = new Set();
  const sources = [];
  for (const it of [...blog, ...local]) {
    const url = it.link;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: stripTags(it.title) || url, url, permanent: true });
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * 지역검색 결과를 지도 링크(네이버지도·구글지도)로 변환한다.
 * 네이버 지역검색은 place id 를 안 주므로, 좌표 대신 "상호명+주소" 검색 링크로 연결한다
 * (좌표 변환 없이도 항상 정확한 위치로 이동함).
 */
function buildPlaces(local) {
  const seen = new Set();
  const places = [];
  for (const it of local) {
    const name = stripTags(it.title);
    const address = stripTags(it.roadAddress || it.address);
    if (!name || !address || seen.has(name)) continue;
    seen.add(name);
    const query = encodeURIComponent(`${name} ${address}`);
    places.push({
      name,
      address,
      naverMapUrl: `https://map.naver.com/p/search/${query}`,
      googleMapUrl: `https://www.google.com/maps/search/?api=1&query=${query}`
    });
  }
  return places;
}

/** 네이버 응답의 <b> 태그·HTML 엔티티를 제거해 순수 텍스트로. */
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}
