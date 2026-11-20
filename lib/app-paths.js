// lib/app-paths.js — 路径与数据目录
//
// 两个坑（都是从表情包应用那边踩过来的）：
//
// ① 数据目录不能用 homedir() 自己拼。宿主发下来的 sdk.dataDir 是真实路径
//    （<hana 主目录>/app-data/shuo-fangyan），而 <hana 主目录> 本身可能是目录联接（Junction）。
//    自己拼出来的是联接路径，宿主通道按真实路径判定，直接拒。
//    所以路径从环境变量 SFY_DATA_DIR 拿（App 入口在 import lib 之前设好）。
//
// ② 伙伴目录（<hana 主目录>/agents）同理。候选有两个：DATA_DIR 往上两级（真实路径）
//    和 HANA_HOME（联接写法）。用宿主通道 list 一下，谁真有 agents 目录就用谁。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = process.env.SFY_DATA_DIR
  || path.join(os.homedir(), '.hanako', 'app-data', 'shuo-fangyan');

export const HANA_HOME = process.env.HANA_HOME
  || path.join(os.homedir(), '.hanako');

/** 伙伴目录的候选根，按「更可能是真实路径」排序。 */
export function agentsRootCandidates() {
  const roots = [];
  try {
    const fromData = path.dirname(path.dirname(DATA_DIR));
    if (fromData) roots.push(fromData);
  } catch { /* 推导失败就只用 HANA_HOME */ }
  if (HANA_HOME && !roots.includes(HANA_HOME)) roots.push(HANA_HOME);
  return roots;
}

/** 数据目录下的配置文件路径。 */
export function dataFile(name) {
  return path.join(DATA_DIR, name);
}

/** 原子写 JSON：先写临时文件再改名，避免写一半崩溃留下半个文件。 */
export function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return value;
}
