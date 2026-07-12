// 사실 조사(리서치) 오케스트레이터.
// 주제 성격과 사용 가능한 키를 보고 어떤 검색 provider 를 어떤 순서로 부를지 결정한다.
//   - 지역·실존 업체 주제(맛집·카페·여행 등) → 네이버(정확한 상호명) 우선, 부족하면 Gemini 로 보강
//   - 그 외 일반 주제                        → Gemini 그라운딩(웹 검색)
// 리서치는 부가 기능이므로 어느 단계에서 실패해도 글 생성은 막지 않는다(자료 없이 진행).
import { researchWithGemini } from './research/gemini-grounding.js';
import { researchWithNaver } from './research/naver.js';

// "지역·실존 장소" 주제를 판별하는 기본 키워드(네이버가 유리한 주제들).
const DEFAULT_LOCAL_KEYWORDS = [
  '맛집', '카페', '근처', '주변', '골프', 'CC', '컨트리클럽', '여행', '숙소', '호텔',
  '펜션', '리조트', '가볼만한', '데이트', '코스', '명소', '축제', '시장', '거리', '동네'
];

const PROVIDERS = { naver: researchWithNaver, gemini: researchWithGemini };
const LABELS = { naver: '네이버 검색', gemini: 'Gemini 웹검색' };

/**
 * 주제에 대한 사실 조사를 수행한다.
 * @param {{topic:string, instructions?:string, config:object}} args
 * @returns {Promise<{briefing:string, sources:Array<{title:string,url:string}>, providers:string[]}|null>}
 */
export async function researchTopic({ topic, instructions, config }) {
  const rc = config.research || {};
  if (!rc.enabled) return null;

  const order = decideProviders({ topic, instructions, rc });
  if (!order.length) return null;

  const maxSources = rc.maxSources || 5;
  const briefings = [];
  const sources = [];
  const places = [];
  const used = [];

  for (const name of order) {
    try {
      const result = await PROVIDERS[name]({ topic, instructions, config });
      if (result?.briefing) {
        briefings.push(`[${LABELS[name]}]\n${result.briefing}`);
        sources.push(...(result.sources || []));
        places.push(...(result.places || []));
        used.push(name);
      }
    } catch (e) {
      console.warn(`   ⚠️ ${LABELS[name]} 리서치 실패 — 건너뜁니다. (${e.message})`);
    }

    // 이미 충분한 자료를 모았으면 남은 provider 는 부르지 않는다(비용·시간 절약).
    // → 지역 주제에서 네이버가 잘 나오면 Gemini 는 생략된다("상황에 따라 호출").
    if (rc.stopWhenEnough !== false && briefings.length && sources.length >= maxSources) break;
  }

  if (!briefings.length) return null;

  return {
    briefing: briefings.join('\n\n'),
    sources: dedupeSources(sources, maxSources),
    places: dedupePlaces(places),
    providers: used
  };
}

/**
 * 상황에 따라 호출할 provider 순서를 정한다.
 * strategy: 'auto'(기본) | 'naver' | 'gemini' | 'naver+gemini'
 */
function decideProviders({ topic, instructions, rc }) {
  const hasNaver = !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const avail = { naver: hasNaver, gemini: hasGemini };
  const keep = (arr) => arr.filter((n) => avail[n]);

  const strategy = rc.strategy || 'auto';
  if (strategy === 'naver') return keep(['naver', 'gemini']);            // 네이버 우선, 없으면 Gemini
  if (strategy === 'gemini') return keep(['gemini', 'naver']);           // Gemini 우선, 없으면 네이버
  if (strategy === 'naver+gemini') return keep(['naver', 'gemini']);     // 둘 다(순서대로)

  // auto: 주제가 지역·장소성이면 네이버 우선(+부족 시 Gemini), 아니면 Gemini 한 곳만.
  if (isLocalTopic(topic, instructions, rc)) return keep(['naver', 'gemini']);
  return keep(['gemini', 'naver']).slice(0, 1);
}

/** 주제/요청사항에 지역·장소 키워드가 있으면 true. */
function isLocalTopic(topic, instructions, rc) {
  const keywords = rc.localKeywords || DEFAULT_LOCAL_KEYWORDS;
  const text = `${topic || ''} ${instructions || ''}`;
  return keywords.some((k) => text.includes(k));
}

/** 출처 URL 중복 제거 후 상한만큼 자른다. */
function dedupeSources(sources, limit) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** 상호명 중복 제거(같은 곳이 지역검색에 두 번 잡히는 경우 방지). */
function dedupePlaces(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    if (!p?.name || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

/**
 * 참고 자료 출처를 본문 끝에 붙일 "참고 자료" 링크 HTML 로 만든다(없으면 '').
 * related.js 의 "함께 읽으면 좋은 글" 과 같은 패턴.
 * 영구 URL(permanent!==false)만 노출한다 — Gemini 그라운딩 리다이렉트는 만료되므로 제외.
 */
export function sourceLinksHtml(sources) {
  const shown = (sources || []).filter((s) => s?.url && s.permanent !== false);
  if (!shown.length) return '';
  const items = shown
    .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></li>`)
    .join('');
  return `\n<h2>참고 자료</h2>\n<ul>${items}</ul>\n`;
}

/**
 * 본문에 등장하는 실존 업체의 지도 링크(네이버지도·구글지도)를 목록으로 붙인다(없으면 '').
 * 독자가 클릭해서 바로 위치를 찾아갈 수 있도록 하기 위함(naver.js 의 buildPlaces 참고).
 */
export function placeLinksHtml(places) {
  const shown = (places || []).filter((p) => p?.name && (p.naverMapUrl || p.googleMapUrl));
  if (!shown.length) return '';
  const items = shown
    .map((p) => {
      const links = [
        p.naverMapUrl ? `<a href="${escapeHtml(p.naverMapUrl)}" target="_blank" rel="noopener">네이버지도</a>` : '',
        p.googleMapUrl ? `<a href="${escapeHtml(p.googleMapUrl)}" target="_blank" rel="noopener">구글지도</a>` : ''
      ].filter(Boolean).join(' · ');
      return `<li>${escapeHtml(p.name)} — ${links}</li>`;
    })
    .join('');
  return `\n<h2>위치 찾아가기</h2>\n<ul>${items}</ul>\n`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
