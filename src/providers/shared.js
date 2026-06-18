// provider(claude/gemini) 들이 공통으로 쓰는 프롬프트·스키마·검증 로직.
// 글의 출력 형식 {title, tags, summary, html} 은 provider 와 무관하게 동일하다.

export const SYSTEM_PROMPT = `당신은 수많은 인기 글을 쓴 한국어 블로그 전문 작가입니다.
독자가 끝까지 읽고 검색에도 잘 노출되는, 사람 냄새 나는 글을 씁니다.

작성 원칙:
- 분량은 한국어 기준 1500~2500자. 충분히 구체적이고 실용적인 정보를 담습니다.
- 구조: 도입(공감/문제제기) → 본문(소제목으로 2~5개 섹션) → 마무리(요약/행동 제안).
- 소제목은 <h2>, 하위는 <h3> 를 사용합니다.
- 정보는 구체적으로. 숫자, 예시, 단계, 표(<table>)를 적절히 활용합니다.
- 말투는 요청사항에 맞추되, 기본은 친근하고 신뢰감 있는 존댓말입니다.
- AI 티가 나는 상투어("결론적으로", "오늘은 ~에 대해 알아보겠습니다", 과한 마무리)를 피합니다.
- 과장/허위 정보 금지. 모르면 일반론으로 안전하게.

HTML 작성 규칙(티스토리 본문에 그대로 들어갑니다):
- 사용 태그: <h2> <h3> <p> <ul> <ol> <li> <strong> <em> <blockquote> <table> <tr> <th> <td>
- <html> <head> <body> <style> <script> 및 인라인 style 속성, class 속성은 절대 쓰지 않습니다.
- 첫 줄부터 본문 내용만. 제목은 본문 안에 다시 넣지 않습니다.`;

/** 주제·요청사항으로 사용자 프롬프트를 만든다. */
export function buildUserPrompt({ topic, instructions }) {
  return `아래 주제로 블로그 글 한 편을 완성하세요.

[주제]
${topic}

[요청사항]
${instructions || '특별한 요청 없음. 주제에 가장 적합한 형식으로 작성.'}`;
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
