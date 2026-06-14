// 글 생성 진입점. config.llm.provider 에 따라 무료(gemini)/유료(claude) 구현으로 분기한다.
// provider 를 바꾸려면 config.json 의 "provider" 한 줄만 수정하면 된다.
import { generate as claude } from './providers/claude.js';
import { generate as gemini } from './providers/gemini.js';

const PROVIDERS = { claude, gemini };

/**
 * 설정된 provider로 블로그 글을 생성한다.
 * @returns {Promise<{title:string, tags:string[], summary:string, html:string}>}
 */
export async function generateArticle({ topic, instructions, config }) {
  const provider = config.llm?.provider || 'claude';
  const impl = PROVIDERS[provider];
  if (!impl) {
    throw new Error(`알 수 없는 LLM provider: "${provider}" (지원: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return impl({ topic, instructions, config });
}
