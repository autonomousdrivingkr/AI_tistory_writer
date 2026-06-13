import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `당신은 수많은 인기 글을 쓴 한국어 블로그 전문 작가입니다.
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

const ARTICLE_TOOL = {
  name: 'submit_article',
  description: '완성된 블로그 글을 구조화하여 제출합니다.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '클릭을 부르면서 검색 키워드를 담은 한국어 제목. 30~45자 권장.'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '검색 유입을 위한 키워드 태그 5~8개.'
      },
      summary: {
        type: 'string',
        description: '검색 결과에 노출될 1~2문장 요약(메타 설명).'
      },
      html: {
        type: 'string',
        description: '본문 HTML. 시스템 프롬프트의 HTML 규칙을 반드시 준수.'
      }
    },
    required: ['title', 'tags', 'summary', 'html']
  }
};

/**
 * Claude로 블로그 글을 생성한다.
 * @returns {Promise<{title:string, tags:string[], summary:string, html:string}>}
 */
export async function generateArticle({ topic, instructions, config }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.');

  const client = new Anthropic({ apiKey });

  const userPrompt = `아래 주제로 블로그 글 한 편을 완성해서 submit_article 도구로 제출하세요.

[주제]
${topic}

[요청사항]
${instructions || '특별한 요청 없음. 주제에 가장 적합한 형식으로 작성.'}`;

  const resp = await client.messages.create({
    model: config.llm.model,
    max_tokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    system: SYSTEM_PROMPT,
    tools: [ARTICLE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_article' },
    messages: [{ role: 'user', content: userPrompt }]
  });

  const toolUse = resp.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('모델이 글을 생성하지 못했습니다.');

  const article = toolUse.input;
  if (!article.title || !article.html) {
    throw new Error('생성된 글에 제목 또는 본문이 없습니다.');
  }
  return article;
}
