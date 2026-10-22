#!/usr/bin/env node
/**
 * smoke-test.mjs · 可重复执行的冒烟测试（一条命令判 PASS/FAIL）
 * ---------------------------------------------------------------------------
 * 模拟"零基础新用户"的完整路径：
 *   启动向导 → 自动检测运行环境 → 默认勾选板块 → 点「开始安装」
 *   → 落盘核验（版本/文件数/板块） → LV0 协议页入口 → 清理
 *
 * 实现方式：拉起真实 Electron（走真实 UI 点击，不 mock IPC），
 * 由主进程把判定写进 artifacts/qa/smoke-report.json，本脚本读报告并退出。
 *
 * 用法：
 *   node packaging/scripts/smoke-test.mjs            # 默认用临时目录，不碰真实安装位
 *   node packaging/scripts/smoke-test.mjs --keep     # 保留临时目录便于排查
 *   node packaging/scripts/smoke-test.mjs --timeout 120000
 *
 * 退出码：0 = PASS；1 = FAIL（含超时/无报告）；2 = 环境缺失（找不到 Electron）
 * ---------------------------------------------------------------------------
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 本脚本在 <repo>/scripts/，工程根在 <repo>/packaging/
const PKG = resolve(HERE, "..", "packaging");
const SHELL = join(PKG, "installer", "shell");
const QA_DIR = join(PKG, "artifacts", "qa");
const REPORT = join(QA_DIR, "smoke-report.json");

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const timeoutIdx = argv.indexOf("--timeout");
const timeoutMs = timeoutIdx > -1 ? Number(argv[timeoutIdx + 1]) : 90000;

/** 找 electron.exe（尊重 electron 包写的 path.txt） */
function findElectron() {
  const pathFile = join(SHELL, "node_modules", "electron", "path.txt");
  if (existsSync(pathFile)) {
    const rel = readFileSync(pathFile, "utf8").trim();
    const abs = join(SHELL, "node_modules", "electron", rel);
    if (existsSync(abs)) return abs;
  }
  const direct = join(SHELL, "node_modules", "electron", "dist", "electron.exe");
  return existsSync(direct) ? direct : null;
}

function fail(msg, code = 1) {
  console.error(`❌ ${msg}`);
  process.exit(code);
}

const electron = findElectron();
if (!electron) {
  fail(
    "找不到 Electron 可执行文件。请先在 packaging/installer/shell 执行：\n" +
      "  pnpm install\n" +
      "  node node_modules/electron/install.js   # 需 ELECTRON_MIRROR\n",
    2,
  );
}

// 每次跑都清掉旧报告，避免读到上次的 PASS 造成假绿
try {
  if (existsSync(REPORT)) rmSync(REPORT, { force: true });
} catch {
  /* ignore */
}

const targetDir = mkdtempSync(join(tmpdir(), "dsh-training-smoke-"));
const env = { ...process.env, DSH_TRAINING_SMOKE: "1", DSH_TRAINING_TARGET_DIR: targetDir };
// 关键：DSH 环境默认带这个变量，会让 electron.exe 当 Node 跑（ipcMain undefined）
delete env.ELECTRON_RUN_AS_NODE;
delete env.DSH_TRAINING_SELFTEST;
delete env.DSH_TRAINING_SELFTEST_INSTALL;
delete env.DSH_TRAINING_SELFTEST_EXPECT;

console.log("=== dsh-training 冒烟测试 ===");
console.log(`Electron   ：${electron}`);
console.log(`安装目标   ：${targetDir}（临时目录，跑完清理）`);
console.log(`超时       ：${timeoutMs} ms\n`);

const child = spawn(electron, ["."], { cwd: SHELL, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
const collect = (buf) => {
  const text = buf.toString();
  output += text;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes("[smoke]")) console.log(line);
  }
};
child.stdout.on("data", collect);
child.stderr.on("data", collect);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  // 只杀这一棵进程树（按 PID + /T），不碰系统里其它 electron
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}, timeoutMs);

child.on("exit", (code) => {
  clearTimeout(timer);

  let report = null;
  if (existsSync(REPORT)) {
    try {
      report = JSON.parse(readFileSync(REPORT, "utf8"));
    } catch (e) {
      console.error(`报告解析失败：${e.message}`);
    }
  }

  if (!keep) rmSync(targetDir, { recursive: true, force: true });

  if (timedOut) {
    console.error(`\n❌ 冒烟超时（${timeoutMs} ms），已终止 Electron`);
    if (output) console.error(output.slice(-2000));
    process.exit(1);
  }

  if (!report) {
    console.error("\n❌ 没有拿到冒烟报告（Electron 可能启动失败）");
    if (output) console.error(output.slice(-2000));
    process.exit(1);
  }

  console.log("\n=== 步骤明细 ===");
  for (const s of report.steps) {
    console.log(`${s.ok ? "✅" : "❌"} ${s.name}`);
    if (!s.ok) console.log(`   数据：${JSON.stringify(s.data)}`);
  }

  console.log(`\n报告：artifacts/qa/smoke-report.json`);
  console.log(`截图：artifacts/qa/smoke-wizard.png`);
  console.log(`\n=== 结果：${report.result}（electron 退出码 ${code}）===`);
  process.exit(report.result === "PASS" ? 0 : 1);
});

child.on("error", (err) => {
  clearTimeout(timer);
  console.error(`❌ 启动 Electron 失败：${err.message}`);
  process.exit(1);
});
