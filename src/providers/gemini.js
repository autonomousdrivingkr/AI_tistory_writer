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
    html: { type: Type.STRING, description: '본문 HTML. 시스템 프롬프트의 HTML 규칙을 반드시 준수.' }
  },
  required: ['title', 'tags', 'summary', 'html'],
  propertyOrdering: ['title', 'tags', 'summary', 'html']
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
        responseMimeType: 'application/json',
        responseSchema: ARTICLE_SCHEMA
      }
    });
  } catch (e) {
    throw friendlyError(e, config);
  }

  const text = resp.text;
  if (!text) throw new Error('모델이 글을 생성하지 못했습니다.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini 응답을 JSON 으로 해석하지 못했습니다.');
  }
  return validateArticle(parsed);
}

/** SDK 가 던지는 장황한 JSON 에러를 간결하고 행동 가능한 메시지로 바꾼다. */
function friendlyError(e, config) {
  const msg = e?.message || String(e);
  const is429 = e?.status === 429 || /RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
  if (is429) {
    return new Error(
      `Gemini 무료 한도/쿼터를 초과했습니다 (429, 모델: ${modelFor(config)}). ` +
      '잠시 후 다시 시도하거나, config.json 의 llm.provider 를 "claude" 로 바꿔 발행하세요.'
    );
  }
  return e instanceof Error ? e : new Error(msg);
}
