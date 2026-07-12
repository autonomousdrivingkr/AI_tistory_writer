import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, localDate } from './config.js';

const STATE_PATH = join(ROOT, 'state.json');

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

/** 주제 파일(블로그별)의 절대 경로 */
function topicsPath(topicsFile) {
  return join(ROOT, topicsFile || 'topics.json');
}

/** 현재 시각이 어느 슬롯(morning/evening)에 해당하는지 판별. 범위 밖이면 null */
export function currentSlot(config, now = new Date()) {
  const hour = now.getHours();
  const { morning, evening } = config.schedule.slots;
  if (hour >= morning.startHour && hour < morning.endHour) return 'morning';
  if (hour >= evening.startHour && hour < evening.endHour) return 'evening';
  return null;
}

/**
 * 슬롯의 고유 키: 2026-06-14-morning-captainzone
 * blogId 를 붙여 블로그별로 중복방지 기록을 따로 둔다(같은 슬롯에 블로그마다 1편씩 가능).
 */
export function slotKey(slot, now = new Date(), blogId) {
  const base = `${localDate(now)}-${slot}`;
  return blogId ? `${base}-${blogId}` : base;
}

/** 해당 블로그·슬롯이 이미 발행되었는지 (PC/GitHub 중복 방지의 핵심) */
export function isPublished(slot, now = new Date(), blogId) {
  const state = readJson(STATE_PATH, { published: [] });
  const key = slotKey(slot, now, blogId);
  return state.published.some((p) => p.key === key);
}

/** 발행 기록 추가 */
export function recordPublished(entry) {
  const state = readJson(STATE_PATH, { published: [] });
  state.published.push(entry);
  // 최근 200건만 유지
  state.published = state.published.slice(-200);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/** 해당 블로그의 다음 발행할 pending 주제 1건 반환 (없으면 null) */
export function pickNextTopic(topicsFile) {
  const topics = readJson(topicsPath(topicsFile), []);
  return topics.find((t) => t.status === 'pending') || null;
}

/** 해당 블로그의 pending 주제 전체 목록 반환 (테스트 발행 시 주제 선택용) */
export function listPendingTopics(topicsFile) {
  const topics = readJson(topicsPath(topicsFile), []);
  return topics.filter((t) => t.status === 'pending');
}

/** 해당 블로그의 주제를 발행 완료로 표시 */
export function markTopicDone(topic, topicsFile, meta = {}) {
  const path = topicsPath(topicsFile);
  const topics = readJson(path, []);
  const item = topics.find((t) => t.topic === topic && t.status === 'pending');
  if (item) {
    item.status = 'done';
    item.publishedAt = new Date().toISOString();
    if (meta.url) item.url = meta.url;
  }
  writeFileSync(path, JSON.stringify(topics, null, 2) + '\n');
}

export function pendingCount(topicsFile) {
  const topics = readJson(topicsPath(topicsFile), []);
  return topics.filter((t) => t.status === 'pending').length;
}
