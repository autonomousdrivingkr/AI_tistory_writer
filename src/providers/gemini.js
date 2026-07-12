// 무료 provider: Google Gemini. responseSchema(JSON 구조화 출력)로 글을 받는다.
// 무료 API 키는 https://aistudio.google.com/apikey 에서 발급.
import { GoogleGenAI, Type } from '@google/genai';
import { SYSTEM_PROMPT, buildUserPrompt, modelFor, validateArticle } from './shared.js';

const ARTICLE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '클릭을 부르는 한국어 제목. 핵심 검색 키워드를 제목 앞부분에 배치. 30~45자 권장.' },
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

export async function generate({ topic, instructions, config, research }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.');

  const ai = new GoogleGenAI({ apiKey });

  let resp;
  try {
    resp = await withRetry(() => ai.models.generateContent({
      model: modelFor(config),
      contents: buildUserPrompt({ topic, instructions, research }),
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
    }), config);
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

// 503(UNAVAILABLE)·과부하, 500(INTERNAL) 은 구글 측 일시적 장애다. 지수 백오프로 재시도하면 대개 풀린다.
const MAX_RETRIES = 4;        // 첫 시도 + 4회 재시도 = 총 5회
const BASE_DELAY_MS = 2000;   // 2s → 4s → 8s → 16s (+ 지터)

/** 일시적 서버 오류(503 과부하 / 500 내부 오류)면 지수 백오프로 재시도한다. */
async function withRetry(fn, config) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === MAX_RETRIES) throw e;
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      console.log(
        `   ⏳ '${modelFor(config)}' ${reasonLabel(e)}. ` +
        `${Math.round(delay / 1000)}초 후 재시도 (${attempt + 1}/${MAX_RETRIES})...`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** 다시 시도하면 풀릴 가능성이 높은 일시적 서버 오류인지. */
function isRetryable(e) {
  return isOverloaded(e) || isInternal(e);
}

/** 모델 서버가 일시적으로 과부하라 다시 시도하면 풀릴 가능성이 높은 에러인지. */
function isOverloaded(e) {
  const msg = e?.message || String(e);
  return e?.status === 503 || /UNAVAILABLE|overloaded|high demand|try again later/i.test(msg);
}

/** 구글 서버 내부 오류(500/INTERNAL). 일시적 장애라 재시도하면 대개 풀린다. */
function isInternal(e) {
  const msg = e?.message || String(e);
  return e?.status === 500 || e?.code === 500 ||
    /\bINTERNAL\b|"code"\s*:\s*500|internal error has occurred/i.test(msg);
}

/** 재시도 로그에 표시할 오류 사유 라벨. */
function reasonLabel(e) {
  if (isOverloaded(e)) return '일시적 과부하(503)';
  if (isInternal(e)) return '서버 내부 오류(500 INTERNAL)';
  return '일시적 오류';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SDK 가 던지는 장황한 JSON 에러를 간결하고 행동 가능한 메시지로 바꾼다. */
function friendlyError(e, config) {
  const msg = e?.message || String(e);
  const model = modelFor(config);
  if (isOverloaded(e)) {
    return new Error(
      `'${model}' 서버가 일시적으로 과부하 상태입니다 (503, 재시도 ${MAX_RETRIES}회 모두 실패). ` +
      '잠시 후 다시 시도하거나, config.json 의 llm.models.gemini 를 "gemini-2.5-flash-lite" 등 ' +
      '다른 모델로 바꾸거나, llm.provider 를 "claude" 로 바꿔 발행하세요.'
    );
  }
  if (isInternal(e)) {
    return new Error(
      `'${model}' 서버에서 내부 오류가 발생했습니다 (500 INTERNAL, 재시도 ${MAX_RETRIES}회 모두 실패). ` +
      '구글 측 일시적 장애일 수 있으니 잠시 후 다시 시도하세요. ' +
      '계속되면 config.json 의 llm.models.gemini 를 "gemini-2.5-flash" 등 다른 모델로 바꾸거나, ' +
      'llm.provider 를 "claude" 로 바꿔 발행하세요. ' +
      '입력이 지나치게 길 때도 발생할 수 있으니 주제/세부 지시를 줄여보는 것도 방법입니다.'
    );
  }
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
