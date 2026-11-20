// lib/consent.js — 首次使用的知情确认
//
// 这个应用会把方言写进伙伴的人格文件。第一次进来先把这件事说清楚，
// 用户点过「知道了」才让页面继续挑口音，后端也拦住没确认过的保存请求。
//
// 为什么单独存一份：确认「用户知道自己在改 ta 的人格」是这件事本身，
// 跟方言配置是两码事。以后清空方言、重置配置，都不该顺手把确认也清掉
// （那等于让人不声不响地又改一次人格）。

import fs from 'node:fs';
import { dataFile, atomicWriteJson } from './app-paths.js';

const CONSENT_FILE = dataFile('consent.json');

/** 读确认凭据。文件不在、读坏了，一律按「没确认过」处理。 */
export function readConsent() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONSENT_FILE, 'utf8'));
    return {
      accepted: raw?.accepted === true,
      at: typeof raw?.at === 'string' ? raw.at : '',
    };
  } catch {
    return { accepted: false, at: '' };
  }
}

/** 记下确认。只认布尔 true，别的写法一律当没确认。 */
export function acceptConsent() {
  const record = { accepted: true, at: new Date().toISOString() };
  atomicWriteJson(CONSENT_FILE, record);
  return record;
}
