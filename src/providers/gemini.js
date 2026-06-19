// 무료 provider: Google Gemini. responseSchema(JSON 구조화 출력)로 글을 받는다.
// 무료 API 키는 https://aistudio.google.com/apikey 에서 발급.
import { GoogleGenAI, Type } from '@google/genai';
import { SYSTEM_PROMPT, buildUserPrompt, modelFor, validateArticle } from './shared.js';

const ARTICLE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '클릭을 부르면서 검색 키워드를 담은 한국어 제목. 30~45자 권장.' },
    tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: '검색 유입용 키워드 태그 5~8개.' },
    summary: { type: Type.STRING, description: '검색 결과에 노출될 1~2문장 요약(메타 설명).' },
    imageQueries: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '본문과 어울리는 사진을 찾기 위한 영어 검색 키워드 3~5개. 사진으로 표현 가능한 구체적 명사/장면 위주(예: "morning coffee desk", "city skyline at night", "hiking mountain trail").'
    },
    html: { type: Type.STRING, description: '본문 HTML. 시스템 프롬프트의 HTML 규칙을 반드시 준수.' }
  },
  required: ['title', 'tags', 'summary', 'imageQueries', 'html'],
  propertyOrdering: ['title', 'tags', 'summary', 'imageQueries', 'html']
};

export async function generate({ topic, instructions, config }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.');

  const ai = new GoogleGenAI({ apiKey });

  let resp;
  try {
    resp = await ai.models.generateContent({
      model: modelFor(config),
      contents: buildUserPrompt({ topic, instructions }),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: config.llm.temperature,
        maxOutputTokens: config.llm.maxTokens,
        // 2.5 계열은 thinking(추론) 모델이라 기본적으로 출력 토큰 예산을 추론에 먼저 써버린다.
        // 추론을 끄면 maxOutputTokens 전부가 본문 JSON 출력에 쓰여 잘림을 막는다.
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: ARTICLE_SCHEMA
      }
    });
  } catch (e) {
    throw friendlyError(e, config);
  }

  // 토큰 한도에 걸려 응답이 중간에 잘리면 JSON 이 깨진다. 모호한 파싱 에러 대신 원인을 명확히 알린다.
  const finishReason = resp.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    throw new Error(
      `응답이 토큰 한도(maxTokens: ${config.llm.maxTokens})에 걸려 중간에 잘렸습니다. ` +
      'config.json 의 llm.maxTokens 를 더 크게(예: 16000~20000) 올리세요.'
    );
  }

  const text = resp.text;
  if (!text) throw new Error('모델이 글을 생성하지 못했습니다.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      'Gemini 응답을 JSON 으로 해석하지 못했습니다. ' +
      '응답이 잘렸을 가능성이 큽니다 — config.json 의 llm.maxTokens 를 올려보세요.'
    );
  }
  return validateArticle(parsed);
}

/** SDK 가 던지는 장황한 JSON 에러를 간결하고 행동 가능한 메시지로 바꾼다. */
function friendlyError(e, config) {
  const msg = e?.message || String(e);
  const model = modelFor(config);
  const is429 = e?.status === 429 || /RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
  if (is429) {
    // limit: 0 → 이 모델의 무료 티어 할당 자체가 막힌 경우. 재시도해도 영원히 안 풀린다.
    // (쿼터는 키가 아니라 프로젝트 단위라 키를 새로 만들어도 동일하다.)
    if (/limit:\s*0\b/.test(msg)) {
      return new Error(
        `'${model}' 은(는) 이 프로젝트에서 무료 사용이 막혀 있습니다 (무료 한도 0). ` +
        '키를 새로 만들어도 동일합니다(쿼터는 프로젝트 단위). ' +
        'config.json 의 llm.models.gemini 를 "gemini-2.5-flash" 등 다른 모델로 바꾸거나, ' +
        'llm.provider 를 "claude" 로 바꿔 발행하세요.'
      );
    }
    const retry = msg.match(/retry in ([\d.]+)s/i)?.[1];
    return new Error(
      `Gemini 무료 분당/일일 한도를 초과했습니다 (429, 모델: ${model}). ` +
      (retry ? `약 ${Math.ceil(Number(retry))}초 후 ` : '잠시 후 ') +
      '다시 시도하거나, config.json 의 llm.provider 를 "claude" 로 바꿔 발행하세요.'
    );
  }
  return e instanceof Error ? e : new Error(msg);
}
