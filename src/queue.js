import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, localDate } from './config.js';

const TOPICS_PATH = join(ROOT, 'topics.json');
const STATE_PATH = join(ROOT, 'state.json');

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

/** 현재 시각이 어느 슬롯(morning/evening)에 해당하는지 판별. 범위 밖이면 null */
export function currentSlot(config, now = new Date()) {
  const hour = now.getHours();
  const { morning, evening } = config.schedule.slots;
  if (hour >= morning.startHour && hour < morning.endHour) return 'morning';
  if (hour >= evening.startHour && hour < evening.endHour) return 'evening';
  return null;
}

/** 슬롯의 고유 키: 2026-06-14-morning */
export function slotKey(slot, now = new Date()) {
  return `${localDate(now)}-${slot}`;
}

/** 해당 슬롯이 이미 발행되었는지 (PC/GitHub 중복 방지의 핵심) */
export function isPublished(slot, now = new Date()) {
  const state = readJson(STATE_PATH, { published: [] });
  const key = slotKey(slot, now);
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

/** 다음 발행할 pending 주제 1건 반환 (없으면 null) */
export function pickNextTopic() {
  const topics = readJson(TOPICS_PATH, []);
  return topics.find((t) => t.status === 'pending') || null;
}

/** pending 주제 전체 목록 반환 (테스트 발행 시 주제 선택용) */
export function listPendingTopics() {
  const topics = readJson(TOPICS_PATH, []);
  return topics.filter((t) => t.status === 'pending');
}

/** 주제를 발행 완료로 표시 */
export function markTopicDone(topic, meta = {}) {
  const topics = readJson(TOPICS_PATH, []);
  const item = topics.find((t) => t.topic === topic && t.status === 'pending');
  if (item) {
    item.status = 'done';
    item.publishedAt = new Date().toISOString();
    if (meta.url) item.url = meta.url;
  }
  writeFileSync(TOPICS_PATH, JSON.stringify(topics, null, 2) + '\n');
}

export function pendingCount() {
  const topics = readJson(TOPICS_PATH, []);
  return topics.filter((t) => t.status === 'pending').length;
}
