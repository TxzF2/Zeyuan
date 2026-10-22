#!/usr/bin/env node
/**
 * test-detect-node.mjs · E-101 / E-102 真机复现测试
 * ---------------------------------------------------------------------------
 * 目标：不只测「函数返回了什么」，而是**让两条失败分支在真机上真实发生**。
 *
 *   OK      ：正常情况下真机 Node 24.21.0 → 通过
 *   E-101   ：把 PATH 剥空（node 命令真的不存在）→ 真走 ENOENT 分支
 *   E-102   ：用 DSH_TRAINING_NODE_MIN=99.0.0 抬高门槛 → 真机 Node 版本真的「过低」
 *             （真机是新版 Node，不抬门槛永远走不到这条分支，这是唯一的端到端办法）
 *
 * 用法：node packaging/scripts/test-detect-node.mjs
 * 退出码：0 = 三个用例全部符合预期
 * ---------------------------------------------------------------------------
 */

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "installer", "shell", "lib", "detect-runtime.js");
const { detectRuntime } = require(LIB);

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}  → 实际 ${actual}${ok ? "" : `，期望 ${expected}`}`);
  ok ? pass++ : fail++;
}

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_MIN = process.env.DSH_TRAINING_NODE_MIN;

/** 每个用例跑完恢复环境，避免互相污染 */
function withEnv(patch, fn) {
  const saved = { PATH: process.env.PATH, DSH_TRAINING_NODE_MIN: process.env.DSH_TRAINING_NODE_MIN };
  try {
    if (patch.PATH !== undefined) process.env.PATH = patch.PATH;
    if (patch.DSH_TRAINING_NODE_MIN !== undefined) process.env.DSH_TRAINING_NODE_MIN = patch.DSH_TRAINING_NODE_MIN;
    return fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.DSH_TRAINING_NODE_MIN === undefined) delete process.env.DSH_TRAINING_NODE_MIN;
    else process.env.DSH_TRAINING_NODE_MIN = saved.DSH_TRAINING_NODE_MIN;
  }
}

// ---------- 用例 1：正常通过 ----------
console.log("=== 用例 1 · OK（真机 Node 可用）===");
const okCase = withEnv({ PATH: ORIGINAL_PATH, DSH_TRAINING_NODE_MIN: undefined }, () => detectRuntime());
console.log(`   code=${okCase.code} actual=${okCase.actual} minimum=${okCase.minimum}`);
console.log(`   文案：${okCase.message}`);
check("退出状态 ok", okCase.ok, true);
check("错误码", okCase.code, "OK");
check("底线版本来自配置文件", okCase.minimum, "22.19.0");

// ---------- 用例 2：E-101（PATH 剥空 → node 真的不存在）----------
console.log("\n=== 用例 2 · E-101（PATH 剥空，node 命令真实缺失）===");
const emptyDir = mkdtempSync(join(tmpdir(), "dsh-empty-path-"));
try {
  const missCase = withEnv({ PATH: emptyDir, DSH_TRAINING_NODE_MIN: undefined }, () => detectRuntime());
  console.log(`   code=${missCase.code} actual=${missCase.actual}`);
  console.log(`   文案：${missCase.message}`);
  console.log(`   提示：${missCase.hint}`);
  check("退出状态 ok=false", missCase.ok, false);
  check("错误码", missCase.code, "E-101");
  check("文案包含「未检测到」", missCase.message.includes("未检测到"), true);
  check("文案承诺不自动安装", missCase.message.includes("不会自动安装"), true);
  check("给了处置建议", missCase.actions.length > 0, true);
} finally {
  rmSync(emptyDir, { recursive: true, force: true });
}

// ---------- 用例 3：E-102（抬高门槛 → 真机版本真的「过低」）----------
console.log("\n=== 用例 3 · E-102（门槛抬到 99.0.0，真机版本低于要求）===");
const oldCase = withEnv({ PATH: ORIGINAL_PATH, DSH_TRAINING_NODE_MIN: "99.0.0" }, () => detectRuntime());
console.log(`   code=${oldCase.code} actual=${oldCase.actual} minimum=${oldCase.minimum}`);
console.log(`   文案：${oldCase.message}`);
console.log(`   提示：${oldCase.hint}`);
check("退出状态 ok=false", oldCase.ok, false);
check("错误码", oldCase.code, "E-102");
check("文案带出真实版本号", oldCase.message.includes(oldCase.actual), true);
check("文案带出要求版本", oldCase.message.includes("99.0.0"), true);
check("建议里提到便携版", String(oldCase.hint).includes("便携版"), true);

// ---------- 用例 4：PATH 恢复后仍正常（防环境污染）----------
console.log("\n=== 用例 4 · 环境恢复后复测 ===");
const again = detectRuntime();
check("恢复后仍为 OK", again.code, "OK");

process.env.PATH = ORIGINAL_PATH;
if (ORIGINAL_MIN !== undefined) process.env.DSH_TRAINING_NODE_MIN = ORIGINAL_MIN;

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
