#!/usr/bin/env node
/**
 * test-install-line.mjs · 安装线故障注入测试（A2 验收项的实证）
 * ---------------------------------------------------------------------------
 * 覆盖场景：
 *   1  全新安装（happy path）
 *   2  升级安装（旧版本进 .backup）
 *   3  写盘失败注入        → E-201，且目标目录不留半成品
 *   4  哈希校验失败注入    → E-205，且**旧版本毫发无损**
 *   5  装配后取消注入      → E-206，staging 清理干净
 *   6  备份后取消注入      → E-206，旧版本被恢复
 *   7  回滚（A2 核心）     → 内容回到上一版
 *   8  卸载               → 只删清单内文件，无残留
 *   9  无备份时回滚        → E-209（可读中文）
 *  10  状态查询           → installed / version / canRollback
 *
 * 用法：node packaging/scripts/test-install-line.mjs
 * 退出码：0 = 全部通过
 * ---------------------------------------------------------------------------
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "installer", "shell", "lib", "installer.js");
const { runInstall, runRollback, runUninstall, getStatus, pathsFor, InstallError } = require(LIB);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}  → 实际 ${actual}${ok ? "" : `，期望 ${expected}`}`);
  ok ? pass++ : fail++;
}
function checkTrue(label, cond, extra = "") {
  check(label, Boolean(cond), true);
  if (!cond && extra) console.log(`   细节：${extra}`);
}

/** 造一个"安装包"：内存里的文件清单 */
function payloadV(version) {
  return [
    { path: "index.html", content: `<h1>dsh-training ${version}</h1>` },
    { path: "resources/app.js", content: `console.log("${version}")` },
    { path: "resources/themes/xingchen.json", content: JSON.stringify({ theme: "xingchen", v: version }) },
  ];
}

const roots = [];
function freshRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-training-${label}-`));
  roots.push(dir);
  return dir;
}
function readApp(targetDir, rel) {
  return readFileSync(join(pathsFor(targetDir).app, ...rel.split("/")), "utf8");
}
function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

async function expectError(label, fn, code) {
  try {
    await fn();
    check(label, "没有抛错", `抛 ${code}`);
  } catch (err) {
    const isInstallError = err instanceof InstallError;
    check(`${label} · 错误码`, isInstallError ? err.code : `非 InstallError(${err?.name})`, code);
    if (isInstallError) console.log(`   中文文案：${err.message}`);
  }
}

try {
  // ---------------- 1. 全新安装 ----------------
  console.log("=== 1 · 全新安装（happy path）===");
  const t1 = freshRoot("fresh");
  const progress = [];
  const r1 = await runInstall({
    targetDir: t1,
    payload: payloadV("0.1.0"),
    version: "0.1.0",
    boards: ["core", "character-txzf"],
    onProgress: (p) => progress.push(p.phase),
  });
  check("安装返回 ok", r1.ok, true);
  check("安装文件数", r1.fileCount, 3);
  check("app 目录存在", existsSync(pathsFor(t1).app), true);
  check("manifest 存在", existsSync(join(pathsFor(t1).app, "install-manifest.json")), true);
  check("内容正确", readApp(t1, "index.html"), "<h1>dsh-training 0.1.0</h1>");
  checkTrue("进度覆盖 stage/verify/commit", ["stage", "verify", "commit"].every((ph) => progress.includes(ph)), progress.join(","));
  const m1 = JSON.parse(readFileSync(join(pathsFor(t1).app, "install-manifest.json"), "utf8"));
  check("清单版本", m1.version, "0.1.0");
  check("清单记录板块数", m1.boards.length, 2);
  check("清单文件数", m1.files.length, 3);
  checkTrue("清单带 sha256", m1.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));

  // ---------------- 2. 升级安装 ----------------
  console.log("\n=== 2 · 升级安装（旧版本进 .backup）===");
  const r2 = await runInstall({ targetDir: t1, payload: payloadV("0.2.0"), version: "0.2.0", boards: ["core"] });
  check("升级 ok", r2.ok, true);
  check("内容已更新", readApp(t1, "index.html"), "<h1>dsh-training 0.2.0</h1>");
  check("备份目录数", subdirs(pathsFor(t1).backupRoot).length, 1);
  check("staging 已清空", subdirs(pathsFor(t1).stagingRoot).length, 0);

  // ---------------- 3. 写盘失败注入 ----------------
  console.log("\n=== 3 · 写盘失败注入（E-201）===");
  const t3 = freshRoot("writefail");
  await expectError("写盘失败", () => runInstall({ targetDir: t3, payload: payloadV("0.1.0"), version: "0.1.0", faults: { failWriteAt: 1 } }), "E-201");
  check("失败后 app 不存在（不留半成品）", existsSync(pathsFor(t3).app), false);
  check("失败后 staging 已清理", subdirs(pathsFor(t3).stagingRoot).length, 0);

  // ---------------- 4. 哈希不符注入（升级场景，旧版必须无损）----------------
  console.log("\n=== 4 · 哈希校验失败（E-205，旧版本必须无损）===");
  const t4 = freshRoot("hashfail");
  await runInstall({ targetDir: t4, payload: payloadV("0.1.0"), version: "0.1.0", boards: ["core"] });
  const before4 = readApp(t4, "index.html");
  await expectError(
    "哈希不符",
    () => runInstall({ targetDir: t4, payload: payloadV("0.9.9"), version: "0.9.9", faults: { corruptFile: "index.html" } }),
    "E-205",
  );
  check("旧版本内容未被污染", readApp(t4, "index.html"), before4);
  check("旧版本清单仍在", existsSync(join(pathsFor(t4).app, "install-manifest.json")), true);
  check("本次未产生备份（失败发生在备份之前）", subdirs(pathsFor(t4).backupRoot).length, 0);

  // ---------------- 5. 装配后取消 ----------------
  console.log("\n=== 5 · 装配后取消（E-206）===");
  const t5 = freshRoot("cancel-stage");
  await expectError("装配后取消", () => runInstall({ targetDir: t5, payload: payloadV("0.1.0"), version: "0.1.0", faults: { cancelAt: "after-stage" } }), "E-206");
  check("取消后 app 不存在", existsSync(pathsFor(t5).app), false);
  check("取消后 staging 已清理", subdirs(pathsFor(t5).stagingRoot).length, 0);

  // ---------------- 6. 备份后取消（旧版必须被恢复）----------------
  console.log("\n=== 6 · 备份后取消（E-206，旧版恢复）===");
  const t6 = freshRoot("cancel-backup");
  await runInstall({ targetDir: t6, payload: payloadV("0.1.0"), version: "0.1.0" });
  await expectError(
    "备份后取消",
    () => runInstall({ targetDir: t6, payload: payloadV("0.2.0"), version: "0.2.0", faults: { cancelAt: "after-backup" } }),
    "E-206",
  );
  check("旧版本已被恢复", readApp(t6, "index.html"), "<h1>dsh-training 0.1.0</h1>");
  check("备份已被移回，无遗留", subdirs(pathsFor(t6).backupRoot).length, 0);

  // ---------------- 7. 回滚（A2 核心）----------------
  console.log("\n=== 7 · 回滚到上一版本（A2 核心）===");
  const t7 = freshRoot("rollback");
  await runInstall({ targetDir: t7, payload: payloadV("0.1.0"), version: "0.1.0" });
  await runInstall({ targetDir: t7, payload: payloadV("0.2.0"), version: "0.2.0" });
  check("回滚前是新版本", readApp(t7, "index.html"), "<h1>dsh-training 0.2.0</h1>");
  const rb = await runRollback({ targetDir: t7 });
  check("回滚 ok", rb.ok, true);
  check("回滚后回到旧版本", readApp(t7, "index.html"), "<h1>dsh-training 0.1.0</h1>");
  check("坏版本进了 .failed", subdirs(pathsFor(t7).failedRoot).length >= 1, true);

  // ---------------- 8. 卸载 ----------------
  console.log("\n=== 8 · 卸载（只删清单内文件）===");
  const un = await runUninstall({ targetDir: t7 });
  check("卸载 ok", un.ok, true);
  check("删除文件数（3 载荷 + 清单本身）", un.removedFiles, 4);
  check("无残留文件", un.leftovers.length, 0);

  // ---------------- 9. 无备份回滚 ----------------
  console.log("\n=== 9 · 无备份时回滚（E-209）===");
  const t9 = freshRoot("no-backup");
  await expectError("无备份回滚", () => runRollback({ targetDir: t9 }), "E-209");

  // ---------------- 10. 状态查询 ----------------
  console.log("\n=== 10 · 状态查询 ===");
  const t10 = freshRoot("status");
  const s0 = await getStatus({ targetDir: t10 });
  check("装之前 installed", s0.installed, false);
  check("装之前 canRollback", s0.canRollback, false);
  await runInstall({ targetDir: t10, payload: payloadV("0.1.0"), version: "0.1.0", boards: ["core"] });
  const s1 = await getStatus({ targetDir: t10 });
  check("装之后 installed", s1.installed, true);
  check("装之后版本", s1.manifest?.version, "0.1.0");
  await runInstall({ targetDir: t10, payload: payloadV("0.2.0"), version: "0.2.0" });
  const s2 = await getStatus({ targetDir: t10 });
  check("升级后 canRollback", s2.canRollback, true);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
