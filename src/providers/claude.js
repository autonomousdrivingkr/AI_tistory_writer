// 유료 provider: Anthropic Claude. tool_use(함수 호출)로 구조화된 글을 받는다.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt, modelFor, validateArticle } from './shared.js';

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
      imageQueries: {
        type: 'array',
        items: { type: 'string' },
        description: '본문과 어울리는 사진을 찾기 위한 영어 검색 키워드 3~5개. 사진으로 표현 가능한 구체적 명사/장면 위주(예: "morning coffee desk", "city skyline at night", "hiking mountain trail").'
      },
      html: {
        type: 'string',
        description: '본문 HTML. 시스템 프롬프트의 HTML 규칙을 반드시 준수.'
      }
    },
    required: ['title', 'tags', 'summary', 'imageQueries', 'html']
  }
};

export async function generate({ topic, instructions, config }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.');

  const client = new Anthropic({ apiKey });

  const resp = await client.messages.create({
    model: modelFor(config),
    max_tokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
    system: SYSTEM_PROMPT,
    tools: [ARTICLE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_article' },
    messages: [{ role: 'user', content: buildUserPrompt({ topic, instructions }) }]
  });

  const toolUse = resp.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('모델이 글을 생성하지 못했습니다.');
  return validateArticle(toolUse.input);
}
