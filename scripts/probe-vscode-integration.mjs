#!/usr/bin/env node
/**
 * probe-vscode-integration.mjs
 * ---------------------------------------------------------------------------
 * dsh-open-in-vscode 集成可用性探测（只读，不做任何安装 / 修改）
 *
 * 背景：npm 上的 dsh-open-in-vscode 已于 2026-08-16 被下架（unpublished），
 *      本机亦未安装 VS Code，因此「集成可用」无法成立。本脚本负责给出
 *      可复现、可审计的证据，而不是给出一个假的「通过」。
 *
 * 判定逻辑（四项全部满足才算 AVAILABLE）：
 *   1) `code` CLI 在 PATH 上可执行
 *   2) VS Code 主程序存在于已知安装路径
 *   3) DSH 当前 profile 已安装 dsh-open-in-vscode（dependencies 或 bundles 列出）
 *   4) npm registry 仍可解析到该包（未被下架/删除）
 *
 * 退出码：0 = AVAILABLE，1 = BLOCKED（并列出阻塞项）
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dsh-open-in-vscode";
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(DSH_HOME, "profiles", "desktop");

/** 已知的 VS Code 安装路径候选 */
const VSCODE_PATHS = [
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
  join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft VS Code", "Code.exe"),
  join(process.env.ProgramW6432 ?? "", "Microsoft VS Code", "Code.exe"),
];

const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

/** 1) code CLI */
function checkCli() {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  try {
    const out = execFileSync(cmd, ["code"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (out.length > 0) {
      record("code CLI", true, out[0]);
      return;
    }
    record("code CLI", false, "`code` 不在 PATH 上");
  } catch {
    record("code CLI", false, "`code` 不在 PATH 上（命令不存在）");
  }
}

/** 2) VS Code 主程序 */
function checkInstallPath() {
  const hit = VSCODE_PATHS.find((p) => p && existsSync(p));
  record("VS Code 安装路径", Boolean(hit), hit ?? "常见安装路径均不存在：" + VSCODE_PATHS.join(" | "));
}

/** 3) DSH profile 是否装了该插件 */
function checkProfilePlugin() {
  const pkgPath = join(PROFILE_DIR, "package.json");
  if (!existsSync(pkgPath)) {
    record(`profile 已装 ${PKG}`, false, `找不到 profile package.json：${pkgPath}`);
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    record(`profile 已装 ${PKG}`, false, `profile package.json 解析失败：${err.message}`);
    return;
  }
  const deps = Object.keys(pkg.dependencies ?? {});
  const bundles = pkg.dsh?.profile?.bundles ?? [];
  const inDeps = deps.includes(PKG);
  const inBundles = bundles.includes(PKG);
  // 兜底：本地插件源码目录里是否已经放了这个包
  const inSources = existsSync(join(DSH_HOME, "plugin-sources", PKG)) || existsSync(join(PROJECT_ROOT, "plugins", PKG));
  const ok = inDeps && inBundles;
  const detail =
    `dependencies=${inDeps ? "有" : "无"} / bundles=${inBundles ? "有" : "无"} / ` +
    `本地源码=${inSources ? "有" : "无"}（profile: ${PROFILE_DIR}）`;
  record(`profile 已装 ${PKG}`, ok, detail);
}

/** 4) registry 是否仍可解析 */
async function checkRegistry() {
  const url = `https://registry.npmjs.org/${PKG}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      // 坑：包被「全量下架」时，registry 仍返回 HTTP 200，只在文档里留
      // time.unpublished 记录、且不再有 dist-tags / versions。只看 res.ok
      // 会得到假阳性 ✅，所以这里必须继续往下核实内容。
      const unpublished = data?.time?.unpublished;
      if (unpublished) {
        const when = unpublished.time ?? "未知时间";
        const vers = Array.isArray(unpublished.versions) ? unpublished.versions.join(", ") : "未知版本";
        record("registry 可解析", false, `${url} → HTTP 200 但已下架（unpublished @ ${when}，原版本 ${vers}）`);
        return;
      }
      const latest = data["dist-tags"]?.latest;
      if (!latest || !data.versions || Object.keys(data.versions).length === 0) {
        record("registry 可解析", false, `${url} → HTTP 200 但无任何可用版本（dist-tags/versions 为空）`);
        return;
      }
      record("registry 可解析", true, `${url} → latest=${latest}`);
      return;
    }
    let reason = `HTTP ${res.status}`;
    if (res.status === 404) {
      try {
        const body = await res.json();
        reason = body.error || "404（可能已被下架 unpublished / 从未发布）";
      } catch {
        reason = "404（可能已被下架 unpublished / 从未发布）";
      }
    }
    record("registry 可解析", false, `${url} → ${reason}`);
  } catch (err) {
    record("registry 可解析", false, `请求失败：${err.message}`);
  }
}

function printTable() {
  const w = Math.max(...checks.map((c) => c.name.length), 8);
  const line = "-".repeat(w + 4 + 62);
  console.log("\n项目环境探测 · dsh-open-in-vscode 集成\n" + line);
  for (const c of checks) {
    console.log(`${c.ok ? "✅" : "❌"}  ${c.name.padEnd(w)}  ${c.detail}`);
  }
  console.log(line);
}

async function main() {
  console.log(`探测目标：${PKG}`);
  console.log(`项目根目录：${PROJECT_ROOT}`);
  console.log(`DSH_HOME：${DSH_HOME}`);
  console.log(`profile：${PROFILE_DIR}`);

  checkCli();
  checkInstallPath();
  checkProfilePlugin();
  await checkRegistry();

  printTable();

  const blocked = checks.filter((c) => !c.ok);
  if (blocked.length === 0) {
    console.log("\n结论：AVAILABLE —— 集成前置条件齐备。");
    process.exit(0);
  }

  console.log(`\n结论：BLOCKED —— ${blocked.length} 项前置条件不满足：`);
  for (const c of blocked) console.log(`  · ${c.name}：${c.detail}`);
  console.log(
    "\n处置建议（按顺序）：\n" +
      "  1. 安装 VS Code 并勾选「添加到 PATH」，确认 `code --version` 可执行；\n" +
      "  2. 确认 dsh-open-in-vscode 的替代安装源（作者仓库 / dshmarket 收录页），npm 官方源已下架；\n" +
      "  3. 装好后把它加入 profile：dsh plugin add <包名或本地路径>；\n" +
      "  4. 重跑本脚本，直至输出 AVAILABLE。\n"
  );
  process.exit(1);
}

main();
