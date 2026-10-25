#!/usr/bin/env node
/**
 * verify-a5.mjs · 验收项 A5 的三层验证（组合层 / 加载层 / 进程层）
 * ---------------------------------------------------------------------------
 * 背景：desktop profile 由 Electron 应用独占，CLI 无法 boot/dump（实测报错），
 *      所以"插件真的被 DSH 加载了"不能靠 CLI 证明，只能分层取证：
 *
 *   L1 组合层：profile 的 dependencies + dsh.profile.bundles 都写对，且 link 目标能解析到 dist
 *   L2 加载层：模块能在真实 cordis Context 里被 ctx.plugin() 挂载（复用 verify-cordis-mount）
 *   L3 进程层：插件 apply() 时写的 mount-state.json（**需要重启 DSH 才会出现**）
 *
 * 判定：
 *   PASS_PROD         L1+L2 通过，且 L3 有 mounted 记录  → A5 真机闭环
 *   PENDING_RESTART   L1+L2 通过，L3 无记录              → 配置就绪，待重启确证（**不假绿**）
 *   FAIL              任一 L1/L2 失败
 *
 * 用法：
 *   node scripts/verify-a5.mjs
 *   node scripts/verify-a5.mjs --json
 * 退出码：0 = PASS_PROD/PENDING_RESTART；1 = FAIL
 * ---------------------------------------------------------------------------
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const LIB = join(REPO, "packaging", "installer", "shell", "lib", "profile-wire.js");
const { inspect } = require(LIB);

const wantJson = process.argv.includes("--json");
const PKG = "zeyuan-protocol";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE_DIR = process.env.DSH_TRAINING_PROFILE_DIR || join(DSH_HOME, "profiles", "desktop");
const STATE_DIR =
  process.env.DSH_TRAINING_STATE_DIR ||
  (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "zeyuan") : join(homedir(), ".zeyuan"));
const MOUNT_STATE = join(STATE_DIR, "mount-state.json");
const MOUNT_EVENTS = join(STATE_DIR, "mount-events.jsonl");

const result = {
  profileDir: PROFILE_DIR,
  mountState: MOUNT_STATE,
  L1: { ok: false, detail: [] },
  L2: { ok: false, detail: "" },
  L3: { state: "PENDING_RESTART", detail: "" },
};

// ---------------- L1 组合层 ----------------
try {
  const info = inspect({ profileDir: PROFILE_DIR, packageName: PKG });
  const details = [];
  details.push(`dependencies: ${info.hasDep ? info.depSpec : "缺失"}`);
  details.push(`bundles: ${info.hasBundle ? "已包含" : "缺失"}（共 ${info.bundleCount} 项）`);

  let linkOk = false;
  if (info.hasDep && info.depSpec?.startsWith("link:")) {
    const target = info.depSpec.slice(5);
    const entry = join(target, "dist", "index.js");
    linkOk = existsSync(entry);
    details.push(`link 目标: ${target}`);
    details.push(`dist/index.js: ${linkOk ? "存在" : "不存在（需 pnpm build）"}`);
  }
  result.L1.ok = info.ready && linkOk;
  result.L1.detail = details;
} catch (err) {
  result.L1.detail = [`读取 profile 失败：${err.code ?? ""} ${err.message}`];
}

// ---------------- L2 加载层（真实 cordis Context） ----------------
try {
  const out = execFileSync(process.execPath, [join(REPO, "scripts", "verify-cordis-mount.mjs")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mounted = out.includes("mounted — LV0 · 未授权");
  const passed = out.includes("cordis loader 级挂载通过");
  result.L2.ok = mounted && passed;
  result.L2.detail = mounted ? "cordis ctx.plugin() 挂载成功，打印了 mounted 行" : "未打印 mounted 行";
} catch (err) {
  result.L2.detail = `执行失败：${err.message?.split("\n")[0] ?? err}`;
}

// ---------------- L3 进程层（优先读事件历史，单文件只留最后一次） ----------------
let lastEvent = null;
if (existsSync(MOUNT_EVENTS)) {
  try {
    const lines = readFileSync(MOUNT_EVENTS, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        // 只认 Electron 宿主的事件：Node 单测/冒烟也会挂载，不能污染 A5 判定
        if (ev.plugin === PKG && ev.host === 'electron') lastEvent = ev;
      } catch {
        /* 跳过坏行 */
      }
    }
    if (lastEvent) result.L3.detail = `事件日志共 ${lines.length} 行，最后一条：${lastEvent.event} @ ${lastEvent.at}`;
  } catch (err) {
    result.L3.detail = `事件日志解析失败：${err.message}`;
  }
}

if (lastEvent) {
  if (lastEvent.event === "mounted" && lastEvent.host === "electron") {
    result.L3.state = "PASS_PROD";
    result.L3.detail = `mounted @ ${lastEvent.at}（host electron, pid ${lastEvent.pid}, level ${lastEvent.level}, version ${lastEvent.version}）`;
  } else {
    result.L3.state = "PENDING_RESTART";
    result.L3.detail = `最后事件为 ${lastEvent.event}（host ${lastEvent.host ?? "?"}, version ${lastEvent.version ?? "?"}, ${lastEvent.at}）——插件当前未挂载，需重启 DSH`;
  }
} else if (existsSync(MOUNT_STATE)) {
  try {
    const state = JSON.parse(readFileSync(MOUNT_STATE, "utf8"));
    // 只认 electron 宿主写出的标记：Node 侧的 cordis 测试也会写标记（host='node'），
    // 若不过滤就会把"测试自己写的"当成"应用真的加载了"——假绿。
    if (state.plugin === PKG && state.event === "mounted" && state.host === "electron") {
      result.L3.state = "PASS_PROD";
      result.L3.detail = `mounted @ ${state.at}（host electron, pid ${state.pid}, level ${state.level}, version ${state.version}）`;
    } else if (state.plugin === PKG && state.event === "mounted") {
      result.L3.state = "PENDING_RESTART";
      result.L3.detail = `标记来自 ${state.host ?? "未知宿主"}（pid ${state.pid}），不是应用内挂载；需重启 DSH Desktop`;
    } else if (state.event === "unmounted") {
      result.L3.state = "PENDING_RESTART";
      result.L3.detail = `标记显示已卸载 @ ${state.at}（应用可能已退出或插件被禁用）`;
    } else {
      result.L3.detail = `标记内容非预期：${JSON.stringify(state).slice(0, 160)}`;
    }
  } catch (err) {
    result.L3.detail = `标记文件解析失败：${err.message}`;
  }
} else {
  result.L3.detail = "尚无 mount-state.json / mount-events.jsonl —— 需要重启 DSH Desktop 才会写入";
}

const verdict =
  !result.L1.ok || !result.L2.ok ? "FAIL" : result.L3.state === "PASS_PROD" ? "PASS_PROD" : "PENDING_RESTART";

if (wantJson) {
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
} else {
  console.log("=== A5 验证（插件是否真的被 DSH 加载）===\n");
  console.log(`profile：${PROFILE_DIR}`);
  console.log(`标记文件：${MOUNT_STATE}\n`);

  console.log(`${result.L1.ok ? "✅" : "❌"} L1 组合层`);
  for (const d of result.L1.detail) console.log(`   · ${d}`);

  console.log(`\n${result.L2.ok ? "✅" : "❌"} L2 加载层（cordis）`);
  console.log(`   · ${result.L2.detail}`);

  console.log(`\n${result.L3.state === "PASS_PROD" ? "✅" : "⏳"} L3 进程层（应用内挂载）`);
  console.log(`   · ${result.L3.detail}`);

  console.log(`\n判定：${verdict}`);
  if (verdict === "PENDING_RESTART") {
    console.log("说明：配置与模块都已就绪，但**进程内挂载证据**需要重启 DSH Desktop 才会产生。");
    console.log("      重启后重跑本脚本；若标记出现 mounted，判定会变成 PASS_PROD。");
  }
}
console.log(`A5_RESULT=${verdict}`);
process.exit(verdict === "FAIL" ? 1 : 0);
