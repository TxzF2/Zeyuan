#!/usr/bin/env node
/**
 * check-agents-config.mjs · agents.config.ts 结构自测
 * ---------------------------------------------------------------------------
 * 目的：用**合法样例 + 非法样例**双向压测校验器，证明结构可用，
 *      并核验当前真实配置（两条角色占位）的实际状态。
 *
 * 用法：node scripts/check-agents-config.mjs
 * 退出码：0 = 全部断言通过
 * ---------------------------------------------------------------------------
 */

import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = resolve(HERE, "..", "plugins", "zeyuan-protocol", "dist", "agents.config.js");
const { AGENTS_CONFIG, validateAgents, loadEnabledAgents } = await import(pathToFileURL(MOD).href);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "✅" : "❌"} ${label}  → 实际 ${actual}${ok ? "" : `，期望 ${expected}`}`);
  ok ? pass++ : fail++;
}

console.log("=== 1. 当前真实配置（角色占位）===");
console.log(`   条目：${AGENTS_CONFIG.map((a) => `${a.name}[${a.role}/${a.source}]`).join("  ")}`);
check("当前配置校验问题数（必须为 0）", validateAgents(AGENTS_CONFIG).length, 0);
check("当前启用 agent 数（占位均 enabled:false）", loadEnabledAgents(AGENTS_CONFIG).agents.length, 0);

console.log("\n=== 2. 合法样例（五种 source 形态）===");
const good = [
  { name: "引导 Agent", source: "dsh-plugin-guide", role: "guide" },
  { name: "陪练 Agent", source: "mcp:trainer-server", role: "trainer" },
  { name: "复盘 Agent", source: "https://example.com/v1", role: "reviewer", enabled: false },
  { name: "待定 Agent", source: "todo:pending-agent", role: "evaluator" },
  { name: "板块 Agent", source: "board:character-txzf", role: "trainer" },
];
check("合法样例问题数", validateAgents(good).length, 0);
check("合法样例启用数（enabled:false 被过滤）", loadEnabledAgents(good).agents.length, 4);
check("按 role 取 guide 命中数", good.filter((a) => a.role === "guide").length, 1);

console.log("\n=== 3. 非法样例（必须逐条拦住）===");
const bad = [
  { name: "", source: "dsh-plugin-x", role: "guide" }, // name 空
  { name: "重复名", source: "dsh-plugin-a", role: "guide" },
  { name: "重复名", source: "dsh-plugin-b", role: "trainer" }, // name 重复
  { name: "坏来源", source: "not a valid source!", role: "guide" }, // source 非法
  { name: "空占位", source: "todo:", role: "guide" }, // todo: 后无内容
  { name: "坏职责", source: "dsh-plugin-c", role: "boss" }, // role 非法
  { name: "带密钥", source: "dsh-plugin-d", role: "guide", note: "api_key=abc123" }, // note 疑似密钥
];
const issues = validateAgents(bad);
check("非法样例问题数 ≥ 6", issues.length >= 6, true);
for (const i of issues) console.log(`   · agents[${i.index}].${i.field}: ${i.message}`);
check("非法条目全部被剔除（0 条可用）", loadEnabledAgents(bad).agents.length, 0);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
