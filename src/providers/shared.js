// provider(claude/gemini) 들이 공통으로 쓰는 프롬프트·스키마·검증 로직.
// 글의 출력 형식 {title, tags, summary, html} 은 provider 와 무관하게 동일하다.

export const SYSTEM_PROMPT = `당신은 수많은 인기 글을 쓴 한국어 블로그 전문 작가입니다.
독자가 끝까지 읽고 검색에도 잘 노출되는, 사람 냄새 나는 글을 씁니다.

작성 원칙:
- 분량은 한국어 기준 1500~2500자. 충분히 구체적이고 실용적인 정보를 담습니다.
- 구조: 도입(공감/문제제기) → 본문(소제목으로 2~5개 섹션) → 마무리(요약/행동 제안).
- 검색 노출(SEO): 핵심 검색 키워드를 정하고, 그 키워드를 제목 앞부분 · 첫 문단 · 첫 소제목(<h2>)에 자연스럽게 배치합니다(키워드 도배 금지).
- 첫 문단(<p>)은 글 전체를 2~3문장으로 요약하면서 핵심 키워드를 포함합니다. 이 문단이 검색 결과 미리보기(메타 설명)로 노출되므로, "오늘은 ~에 대해 알아보겠습니다" 같은 빈 도입 대신 곧장 핵심 정보를 말합니다.
- 소제목은 <h2>, 하위는 <h3> 를 사용합니다.
- 정보는 구체적으로. 숫자, 예시, 단계, 표(<table>)를 적절히 활용합니다.
- 말투는 요청사항에 맞추되, 기본은 친근하고 신뢰감 있는 존댓말입니다.
- AI 티가 나는 상투어("결론적으로", "오늘은 ~에 대해 알아보겠습니다", 과한 마무리)를 피합니다.
- 과장/허위 정보 금지. 모르면 일반론으로 안전하게.

HTML 작성 규칙(티스토리 본문에 그대로 들어갑니다):
- 사용 태그: <h2> <h3> <p> <ul> <ol> <li> <strong> <em> <blockquote> <table> <tr> <th> <td>
- <html> <head> <body> <style> <script> 및 인라인 style 속성, class 속성은 절대 쓰지 않습니다.
- 첫 줄부터 본문 내용만. 제목은 본문 안에 다시 넣지 않습니다.`;

/**
 * 주제·요청사항(+선택: 웹 검색으로 수집한 참고 자료)으로 사용자 프롬프트를 만든다.
 * research 가 있으면 그 사실 자료를 근거로 쓰게 하고, 자료에 없는 구체 정보는 지어내지 않도록 못박는다.
 */
export function buildUserPrompt({ topic, instructions, research }) {
  let prompt = `아래 주제로 블로그 글 한 편을 완성하세요.

[주제]
${topic}

[요청사항]
${instructions || '특별한 요청 없음. 주제에 가장 적합한 형식으로 작성.'}`;

  if (research?.briefing) {
    prompt += `

[참고 자료] (웹 검색으로 수집한 사실 정보입니다. 이 자료를 근거로 글을 쓰세요.)
${research.briefing}

[사실 준수 규칙 — 반드시 지킬 것]
- 구체적 사실(상호명·지명·주소·가격대·영업시간·메뉴 등)은 위 [참고 자료]에 나온 것만 사용하세요.
- 자료에 없는 상호명·가격·수치·거리는 지어내지 마세요. 대신 일반적인 표현으로 부드럽게 서술하세요
  (예: 특정 가격 대신 "가성비 좋은", 없는 상호명 대신 "근처 국밥집" 처럼).
- 단, 분량은 그대로 충분히(한국어 1500~2500자) 채우세요. 구체 사실이 부족하면
  선택 팁·이용 요령·주의사항·일반적인 배경 설명으로 자연스럽게 보완하되, 없는 사실을 단정하지는 마세요.`;
  }

  return prompt;
}

/** 현재 provider 에 해당하는 모델명을 고른다. (config.llm.models 우선, 없으면 구버전 호환) */
export function modelFor(config) {
  const { provider, models, model } = config.llm;
  return models?.[provider] ?? model;
}

/** 모델이 돌려준 글을 검증·정규화한다. provider 가 무엇이든 동일한 형태를 보장. */
export function validateArticle(article) {
  if (!article || typeof article !== 'object') {
    throw new Error('모델이 글을 생성하지 못했습니다.');
  }
  if (!article.title || !article.html) {
    throw new Error('생성된 글에 제목 또는 본문이 없습니다.');
  }
  return {
    title: String(article.title),
    tags: Array.isArray(article.tags) ? article.tags.map(String) : [],
    summary: article.summary ? String(article.summary) : '',
    html: String(article.html),
    imageQueries: Array.isArray(article.imageQueries) ? article.imageQueries.map(String) : []
  };
}
