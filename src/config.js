import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** config.json 을 읽어서 반환 */
export function loadConfig() {
  const raw = readFileSync(join(ROOT, 'config.json'), 'utf-8');
  return JSON.parse(raw);
}

/** 실행 환경 구분: GitHub Actions 면 'github', 아니면 'pc' */
export function runSource() {
  return process.env.GITHUB_ACTIONS === 'true' ? 'github' : 'pc';
}

/**
 * 설정된 블로그 목록을 반환한다.
 * 구버전(단일 tistory.blogName) config 도 자동으로 blogs 배열 1개로 변환해 호환한다.
 */
export function getBlogs(config) {
  const t = config.tistory || {};
  if (Array.isArray(t.blogs) && t.blogs.length) return t.blogs;
  return [{
    id: t.blogName || 'default',
    label: t.blogName || '블로그',
    blogName: t.blogName,
    topicsFile: 'topics.json',
    defaultCategory: t.defaultCategory || ''
  }];
}

/**
 * 블로그별 설정에 전역 기본값(tistory.publish 등)을 합쳐 발행에 쓸 최종 설정을 만든다.
 * 블로그마다 publish/공개여부/세션파일을 따로 두고 싶으면 blogs[].* 에 넣으면 덮어쓴다.
 */
export function resolveBlog(config, blog) {
  const t = config.tistory || {};
  return {
    id: blog.id || blog.blogName,
    label: blog.label || blog.blogName || blog.id,
    blogName: blog.blogName,
    topicsFile: blog.topicsFile || 'topics.json',
    defaultCategory: blog.defaultCategory ?? t.defaultCategory ?? '',
    publish: blog.publish ?? t.publish ?? true,
    publishVisibility: blog.publishVisibility ?? t.publishVisibility ?? 'public',
    // 같은 계정이면 모든 블로그가 storage_state.json 한 개를 공유한다.
    // 다른 계정이면 blogs[].storageStatePath 로 블로그별 세션 파일을 지정하면 된다.
    storageStatePath: blog.storageStatePath || config.storageStatePath || 'storage_state.json'
  };
}

/** 자동 발행(스케줄러/CI)에서 쓸 기본 블로그. defaultBlog id 가 없으면 첫 번째. */
export function defaultBlog(config) {
  const blogs = getBlogs(config);
  const id = (config.tistory || {}).defaultBlog;
  return blogs.find((b) => b.id === id) || blogs[0];
}

/** 로컬 기준 YYYY-MM-DD 날짜 문자열 */
export function localDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
