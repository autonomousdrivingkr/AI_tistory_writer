// generator.js 가 만드는 제한된 태그 집합(h2,h3,p,ul,ol,li,strong,em,blockquote,table,a,img,figure 등)의
// HTML 을 마크다운으로 변환한다. tibedra 처럼 마크다운 본문을 요구하는 플랫폼용.
// 브라우저 DOM 파서를 빌려 쓰는 게 정규식보다 중첩 태그를 안전하게 다룬다.
import { chromium } from 'playwright';

export async function htmlToMarkdown(html) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="root">${html}</div>`);
    return await page.evaluate(() => {
      const escapeMd = (text) => text.replace(/([*_`[\]])/g, '\\$1');
      const convertChildren = (node) => Array.from(node.childNodes).map(convert).join('');

      function convert(node) {
        if (node.nodeType === Node.TEXT_NODE) return escapeMd(node.textContent);
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = node.tagName.toLowerCase();
        switch (tag) {
          case 'strong': return `**${convertChildren(node)}**`;
          case 'em': return `*${convertChildren(node)}*`;
          case 'p': return `${convertChildren(node)}\n\n`;
          case 'h2': return `## ${convertChildren(node)}\n\n`;
          case 'h3': return `### ${convertChildren(node)}\n\n`;
          case 'a': return `[${convertChildren(node)}](${node.getAttribute('href') || ''})`;
          case 'img': return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})\n\n`;
          case 'figcaption': return `*${convertChildren(node).trim()}*\n\n`;
          case 'blockquote': return `> ${convertChildren(node).replace(/\n+/g, ' ').trim()}\n\n`;
          case 'ul': return Array.from(node.children).map((li) => `- ${convertChildren(li).trim()}\n`).join('') + '\n';
          case 'ol': return Array.from(node.children).map((li, i) => `${i + 1}. ${convertChildren(li).trim()}\n`).join('') + '\n';
          case 'table': {
            const rows = Array.from(node.querySelectorAll('tr'));
            if (!rows.length) return '';
            const cellsOf = (tr) => Array.from(tr.children).map((td) => convertChildren(td).trim().replace(/\n+/g, ' '));
            const header = cellsOf(rows[0]);
            const line = (cells) => `| ${cells.join(' | ')} |`;
            const body = rows.slice(1).map(cellsOf);
            return [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n') + '\n\n';
          }
          default: return convertChildren(node);
        }
      }

      return convert(document.getElementById('root')).replace(/\n{3,}/g, '\n\n').trim();
    });
  } finally {
    await browser.close();
  }
}
