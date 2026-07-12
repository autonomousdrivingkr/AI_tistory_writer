// 글 생성 진입점. config.llm.provider 에 따라 무료(gemini)/유료(claude) 구현으로 분기한다.
// provider 를 바꾸려면 config.json 의 "provider" 한 줄만 수정하면 된다.
import { generate as claude } from './providers/claude.js';
import { generate as gemini } from './providers/gemini.js';
import { researchTopic } from './research.js';

const PROVIDERS = { claude, gemini };

/**
 * 설정된 provider로 블로그 글을 생성한다.
 * config.research.enabled 면 먼저 웹 검색으로 사실 자료를 모아 프롬프트에 넣어 환각을 줄인다.
 * @returns {Promise<{title:string, tags:string[], summary:string, html:string, sources?:Array}>}
 */
export async function generateArticle({ topic, instructions, config }) {
  const provider = config.llm?.provider || 'claude';
  const impl = PROVIDERS[provider];
  if (!impl) {
    throw new Error(`알 수 없는 LLM provider: "${provider}" (지원: ${Object.keys(PROVIDERS).join(', ')})`);
  }

  // 사실 조사(웹 검색) — 부가 기능이므로 실패해도 글 생성은 계속한다.
  let research = null;
  if (config.research?.enabled) {
    console.log('   🔎 웹 검색으로 사실 조사 중...');
    try {
      research = await researchTopic({ topic, instructions, config });
      if (research) {
        console.log(`      ✓ 리서치 완료 (${research.providers.join(', ')}) — 출처 ${research.sources.length}건`);
      } else {
        console.log('      · 참고할 검색 결과가 없어 자료 없이 생성합니다.');
      }
    } catch (e) {
      console.warn(`      ⚠️ 리서치 실패 — 자료 없이 생성합니다. (${e.message})`);
    }
  }

  const article = await impl({ topic, instructions, config, research });
  if (research?.sources?.length) article.sources = research.sources;
  if (research?.places?.length) article.places = research.places;
  return article;
}
