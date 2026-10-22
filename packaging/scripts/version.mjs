#!/usr/bin/env node
/**
 * version.mjs · 版本号与产物文件名唯一实现
 * ---------------------------------------------------------------------------
 * 版本号唯一来源：packaging/distribution.json
 * 禁止手改产物文件名——一律用本脚本生成，避免「版本号与文件名不一致」。
 *
 * 用法：
 *   node packaging/scripts/version.mjs                      # 打印当前版本与将产出的文件名
 *   node packaging/scripts/version.mjs --bump patch         # 0.1.0 → 0.1.1
 *   node packaging/scripts/version.mjs --bump minor         # 0.1.0 → 0.2.0
 *   node packaging/scripts/version.mjs --bump major         # 0.1.0 → 1.0.0
 *   node packaging/scripts/version.mjs --pre beta           # 0.1.1 → 0.1.1-beta.1（再跑自增）
 *   node packaging/scripts/version.mjs --set 0.2.0-rc.3     # 直接指定（谨慎）
 * 退出码：0 = 成功；1 = 参数错误
 * ---------------------------------------------------------------------------
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const DIST_FILE = join(PKG_ROOT, "distribution.json");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

function readDist() {
  return JSON.parse(readFileSync(DIST_FILE, "utf8"));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function bump(version, part) {
  const m = version.match(SEMVER);
  if (!m) throw new Error(`当前版本号不符合语义化版本：${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (part === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (part === "minor") {
    minor += 1;
    patch = 0;
  } else if (part === "patch") {
    patch += 1;
  } else {
    throw new Error(`未知的版本段：${part}（只支持 major/minor/patch）`);
  }
  return `${major}.${minor}.${patch}`;
}

function applyPre(version, pre) {
  const m = version.match(SEMVER);
  if (!m) throw new Error(`版本号非法：${version}`);
  const base = version.split("-")[0];
  if (m[4] === pre) return `${base}-${pre}.${Number(m[5]) + 1}`;
  return `${base}-${pre}.1`;
}

/** 生成某形态的产物文件名 */
export function artifactName(dist, form) {
  const f = dist.forms[form];
  if (!f) throw new Error(`distribution.json 未定义形态：${form}`);
  return dist.filePattern
    .replace("{form}", form)
    .replace("{version}", dist.version)
    .replace("{date}", dist.buildDate)
    .replace("{arch}", dist.arch)
    .replace("{ext}", f.ext);
}

function printSummary(dist) {
  console.log(`产品：${dist.displayName}（${dist.product}）`);
  console.log(`版本：v${dist.version} ｜ 阶段：${dist.stage} ｜ 渠道：${dist.channel}`);
  console.log(`构建日期：${dist.buildDate} ｜ 目标：${dist.os}-${dist.arch}`);
  console.log(`内置运行时：Node ${dist.runtime.node}${dist.runtime.electron ? ` / Electron ${dist.runtime.electron}` : ""}`);
  console.log("\n按形态将产出的文件名：");
  for (const form of Object.keys(dist.forms)) {
    const f = dist.forms[form];
    console.log(`  ${form.padEnd(9)} (阶段${f.stage}) → ${artifactName(dist, form)}`);
  }
}

function main(argv) {
  const dist = readDist();
  const i = argv.indexOf("--bump");
  const p = argv.indexOf("--pre");
  const s = argv.indexOf("--set");

  let changed = false;

  if (s > -1) {
    const v = argv[s + 1];
    if (!v || !SEMVER.test(v)) throw new Error(`--set 需要合法语义化版本，收到：${v}`);
    dist.version = v;
    changed = true;
  }

  if (i > -1) {
    const part = argv[i + 1];
    dist.version = bump(dist.version.split("-")[0], part);
    changed = true;
  }

  if (p > -1) {
    const pre = argv[p + 1];
    if (!["alpha", "beta", "rc"].includes(pre)) throw new Error(`--pre 只支持 alpha/beta/rc，收到：${pre}`);
    dist.version = applyPre(dist.version, pre);
    changed = true;
  }

  if (changed) {
    dist.buildDate = today();
    writeFileSync(DIST_FILE, JSON.stringify(dist, null, 2) + "\n", "utf8");
    console.log(`✔ 已更新 distribution.json → v${dist.version}（buildDate=${dist.buildDate}）\n`);
  }

  printSummary(dist);
  return 0;
}

// 只有被直接执行时才跑；被其它脚本 import 时只暴露 artifactName，不产生副作用。
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
