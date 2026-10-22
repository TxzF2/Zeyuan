#!/usr/bin/env node
/**
 * detect-node.mjs · Node 运行时检测（只检测，绝不安装）
 * ---------------------------------------------------------------------------
 * 契约（与 runtime/node-requirements.json 对齐）：
 *   - 只读检测：不下载、不安装、不修改系统级组件
 *   - 输出中文提示，零命令行暴露（向导页直接消费本脚本的 JSON 结果）
 *
 * 用法：
 *   node packaging/runtime/detect-node.mjs            # 人读输出
 *   node packaging/runtime/detect-node.mjs --json     # 机器读（向导页用）
 *
 * 退出码：0 = 可用；1 = 缺失或版本过低（调用方据此显示引导页）
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = JSON.parse(readFileSync(join(HERE, "node-requirements.json"), "utf8"));
const wantJson = process.argv.includes("--json");

const MIN = REQ.minimum.split(".").map(Number);

function parseVersion(raw) {
  const m = String(raw).trim().match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gte(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

let result = { ok: false, code: "E-101", actual: null, minimum: REQ.minimum, message: "", actions: REQ.onMissing.actions };

try {
  const out = execFileSync("node", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const actual = parseVersion(out);
  if (!actual) throw new Error(`无法解析 node -v 输出：${out}`);
  result.actual = actual.join(".");

  if (gte(actual, MIN)) {
    result = { ...result, ok: true, code: "OK", message: `Node ${result.actual} 可用（最低要求 ${REQ.minimum}）`, actions: [] };
  } else {
    result.code = "E-102";
    result.message = `检测到 Node ${result.actual}，低于最低要求 ${REQ.minimum}。请升级后重试，或改用内置运行时的便携版。`;
  }
} catch (err) {
  result.code = "E-101";
  result.message = `未检测到 Node 运行时（${err.message.includes("ENOENT") ? "命令 node 不存在" : err.message}）。本安装包不会自动安装系统级组件。`;
}

if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.ok ? "✅ " + result.message : "❌ " + result.message);
  if (!result.ok) {
    console.log("\n接下来可以：");
    result.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
    console.log("\n官方下载页：https://nodejs.org/zh-cn/download");
  }
}

process.exit(result.ok ? 0 : 1);
