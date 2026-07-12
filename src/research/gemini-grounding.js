// 리서치 provider ①: Google Gemini 그라운딩(웹 검색).
// Gemini 에 googleSearch 도구를 붙여 최신·사실 정보를 검색하고, 그 결과를
// "참고 자료 브리핑" 텍스트 + 출처 목록으로 정리해 돌려준다.
// ⚠️ googleSearch 도구는 responseSchema(JSON 구조화 출력)와 함께 쓸 수 없으므로,
//    여기서는 순수 텍스트로 받아서 오케스트레이터가 그대로 프롬프트에 넣는다.
import { GoogleGenAI } from '@google/genai';

/**
 * @param {{topic:string, instructions?:string, config:object}} args
 * @returns {Promise<{briefing:string, sources:Array<{title:string,url:string}>, provider:'gemini'}|null>}
 */
export async function researchWithGemini({ topic, instructions, config }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const rc = config.research || {};
  const model = rc.models?.gemini || config.llm?.models?.gemini || 'gemini-2.5-flash';
  const ai = new GoogleGenAI({ apiKey });

  const resp = await ai.models.generateContent({
    model,
    contents: buildResearchPrompt({ topic, instructions }),
    config: {
      tools: [{ googleSearch: {} }], // 웹 검색 그라운딩 활성화
      temperature: 0.2,              // 사실 조사이므로 낮게
      maxOutputTokens: 2048
      // responseMimeType/responseSchema 는 googleSearch 와 동시 사용 불가 → 텍스트로 받는다
    }
  });

  const briefing = (resp.text || '').trim();
  if (!briefing) return null;

  return { briefing, sources: extractSources(resp), provider: 'gemini' };
}

/** 사실 조사용 프롬프트 — 블로그 본문이 아니라 "근거 자료"만 뽑아오게 한다. */
function buildResearchPrompt({ topic, instructions }) {
  return `아래 주제로 한국어 블로그 글을 쓰기 위한 "사실 조사"를 해줘.
웹 검색으로 최신·정확한 정보를 찾아 근거 자료만 정리해줘. (글을 쓰는 게 아니라 자료 정리)

[주제]
${topic}

[참고할 요청사항]
${instructions || '없음'}

정리 규칙:
- 실존하는 상호명·지명·주소·가격대·영업시간·메뉴·거리 등 "확인된 구체 사실" 위주로.
- 확실하지 않거나 검색으로 확인 안 된 내용은 적지 말 것.
- 불릿 목록으로 간결하게, 한국어 500~800자 이내.`;
}

/**
 * groundingMetadata 에서 출처(제목·URL)를 뽑아 중복 제거해 돌려준다.
 * Gemini 그라운딩 URL 은 vertexaisearch 리다이렉트라 약 30일 뒤 만료된다 → permanent:false 로 표시해
 * 본문에 영구 링크로 노출하지는 않는다(사실 근거로만 사용). 영구 링크는 네이버 출처가 담당.
 */
function extractSources(resp) {
  const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    const uri = c.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: (c.web?.title || uri).trim(), url: uri, permanent: false });
  }
  return sources;
}
