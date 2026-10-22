#!/usr/bin/env node
/**
 * build.mjs · 安装包构建入口（阶段一：只做校验与干跑）
 * ---------------------------------------------------------------------------
 * 阶段一**不允许产出 exe/zip**（按指令：只做设计与骨架）。因此：
 *   默认 = dry-run：校验清单 + 打印将要产出的产物计划，不写任何产物。
 *   真正构建 → 明确报「阶段二未实现」并以退出码 3 结束，绝不偷偷产出。
 *
 * 用法：
 *   node packaging/scripts/build.mjs              # 干跑（默认）
 *   node packaging/scripts/build.mjs --dry-run    # 同上，显式
 *   node packaging/scripts/build.mjs --stage 2    # 阶段二装配（未实现）
 *   node packaging/scripts/build.mjs --stage 3    # 阶段三安装器（未实现）
 *
 * 退出码：0 = 干跑通过；1 = 清单校验失败；3 = 该阶段未实现
 * ---------------------------------------------------------------------------
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const { artifactName } = await import("./version.mjs");

const SEMVER = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const errors = [];
const warnings = [];
const ok = [];

function fail(msg) {
  errors.push(msg);
}

/** 1. distribution.json 校验 */
function validateDistribution() {
  const file = join(PKG_ROOT, "distribution.json");
  if (!existsSync(file)) return fail("缺少 distribution.json");
  const dist = JSON.parse(readFileSync(file, "utf8"));

  if (!SEMVER.test(dist.version)) fail(`version 不符合语义化版本：${dist.version}`);
  else ok.push(`版本 v${dist.version}`);

  if (dist.stage !== 1) warnings.push(`stage=${dist.stage}（阶段一应为 1）`);
  if (!dist.filePattern.includes("{version}")) fail("filePattern 必须包含 {version}");
  if (!dist.filePattern.includes("{date}")) fail("filePattern 必须包含 {date}（文件名需带日期）");
  if (!dist.runtime?.node) fail("缺少 runtime.node 最低版本要求");

  for (const [form, cfg] of Object.entries(dist.forms ?? {})) {
    if (!cfg.ext) fail(`形态 ${form} 缺少 ext`);
    if (!cfg.stage) fail(`形态 ${form} 缺少 stage`);
  }
  ok.push(`形态 ${Object.keys(dist.forms ?? {}).length} 个`);
  return dist;
}

/** 2. boards.json + 每个板块目录校验 */
function validateBoards() {
  const dist = JSON.parse(readFileSync(join(PKG_ROOT, "distribution.json"), "utf8"));
  const file = join(PKG_ROOT, "boards.json");
  if (!existsSync(file)) return fail("缺少 boards.json");
  const { boards } = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(boards) || boards.length === 0) return fail("boards.json 里没有任何板块");

  const ids = new Set();
  for (const b of boards) {
    if (!ID_PATTERN.test(b.id)) fail(`板块 id 非法：${b.id}`);
    if (ids.has(b.id)) fail(`板块 id 重复：${b.id}`);
    ids.add(b.id);

    if (!["required", "optional", "preview"].includes(b.kind)) fail(`${b.id}: kind 非法（${b.kind}）`);
    if (!["skeleton", "placeholder", "ready"].includes(b.status)) fail(`${b.id}: status 非法（${b.status}）`);

    const dir = join(PKG_ROOT, b.boardDir);
    if (!existsSync(dir)) fail(`${b.id}: 板块目录不存在 ${b.boardDir}`);
    const boardFile = join(dir, "board.json");
    if (!existsSync(boardFile)) {
      fail(`${b.id}: 缺少 board.json（跑 scaffold-boards.mjs 补齐）`);
      continue;
    }
    const doc = JSON.parse(readFileSync(boardFile, "utf8"));
    if (doc.id !== b.id) fail(`${b.id}: board.json 的 id 不一致（${doc.id}）`);

    for (const dep of b.dependsOn ?? []) {
      if (!boards.some((x) => x.id === dep)) fail(`${b.id}: 依赖了不存在的板块 ${dep}`);
    }
    if (b.kind === "required" && b.defaultSelected !== true) {
      fail(`${b.id}: 必装板块 defaultSelected 必须为 true`);
    }
    if (b.kind === "required" && (b.dependsOn ?? []).length > 0) {
      warnings.push(`${b.id}: 必装板块一般不应依赖其它板块`);
    }
  }

  // 必装板块存在性
  if (!boards.some((b) => b.kind === "required")) fail("必须至少有一个 kind=required 的板块");
  ok.push(`板块 ${boards.length} 个（必装 ${boards.filter((b) => b.kind === "required").length}）`);

  return { dist, boards };
}

/** 3. 核心板块的插件产物是否已构建 */
function validateCorePayload() {
  const pluginDist = resolve(PKG_ROOT, "..", "plugins", "dsh-training-protocol", "dist", "index.js");
  if (!existsSync(pluginDist)) {
    warnings.push("核心板块的插件产物不存在（plugins/dsh-training-protocol/dist/index.js）——阶段二装配前需先 pnpm build");
  } else {
    ok.push("核心板块插件产物就绪");
  }
}

function main(argv) {
  const stageArg = argv.indexOf("--stage");
  const stage = stageArg > -1 ? Number(argv[stageArg + 1]) : 1;

  if (stage !== 1) {
    console.error(`⛔ 阶段 ${stage} 的构建尚未实现。`);
    console.error("   阶段一交付范围：packaging/ 骨架 + 两份文档，不产出 exe/zip。");
    console.error("   阶段二才实现便携 zip 装配（内置运行时 + 向导）。");
    return 3;
  }

  console.log("dsh-training 构建 · 阶段一干跑（不写任何产物）\n");

  const dist = validateDistribution();
  const boards = validateBoards();
  validateCorePayload();

  console.log("已通过：");
  ok.forEach((l) => console.log(`  ✅ ${l}`));
  if (warnings.length) {
    console.log("\n提醒：");
    warnings.forEach((l) => console.log(`  ⚠️  ${l}`));
  }
  if (errors.length) {
    console.log("\n错误：");
    errors.forEach((l) => console.log(`  ❌ ${l}`));
    console.log(`\n干跑失败：${errors.length} 项错误`);
    return 1;
  }

  console.log("\n产物计划（阶段一只打印，不生成）：");
  for (const form of Object.keys(dist.forms)) {
    console.log(`  ${artifactName(dist, form)}`);
  }
  console.log("\n✅ 干跑通过。要真正出包，请等阶段二实现后执行 --stage 2。");
  return 0;
}

process.exit(main(process.argv.slice(2)));
