#!/usr/bin/env node
/**
 * scaffold-boards.mjs · 按 boards.json 补齐板块目录骨架
 * ---------------------------------------------------------------------------
 * 维护者用途：在 boards.json 里新增一条板块后，跑本脚本自动建目录与 board.json，
 * 避免手工复制粘贴出错。**幂等**：已存在的 board.json 不会被覆盖。
 *
 * 用法：node packaging/scripts/scaffold-boards.mjs [--force]
 *   --force  覆盖已存在的 board.json（谨慎，会丢弃手写内容）
 * 退出码：0 = 完成（含「无新增」）
 * ---------------------------------------------------------------------------
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const force = process.argv.includes("--force");

const { boards } = JSON.parse(readFileSync(join(PKG_ROOT, "boards.json"), "utf8"));

const isAssetBoard = (id) => /^(character|theme)-/.test(id);

/** 板块安装落点：核心装进 profile，其余装进资产目录 */
function installTargetFor(board) {
  if (board.id === "core") return { target: "profiles/desktop", mode: "plugin-link" };
  if (board.id.startsWith("character-")) return { target: `characters/${board.id.slice("character-".length)}`, mode: "copy" };
  if (board.id.startsWith("theme-")) return { target: `assets/themes/${board.id.slice("theme-".length)}`, mode: "copy" };
  return { target: `features/${board.id.slice("feature-".length)}`, mode: "copy" };
}

function boardJson(board) {
  const doc = {
    id: board.id,
    displayName: board.displayName,
    kind: board.kind,
    status: board.status,
    dependsOn: board.dependsOn ?? [],
    defaultSelected: board.defaultSelected ?? false,
    install: installTargetFor(board),
    contents: [
      "（占位）待阶段三填充实际产物",
    ],
    placeholderNote: "阶段一仅骨架：本板块不产真实文件，勾选与否都不影响核心功能。",
  };
  if (isAssetBoard(board.id)) doc.assetManifest = "asset-manifest.json";
  return doc;
}

function assetManifest(board) {
  const name = board.displayName;
  return {
    board: board.id,
    displayName: name,
    version: "0.1.0",
    status: "placeholder",
    note: "占位清单：字段已定，条目待阶段三补齐（status 保持 TODO 即代表未交付）。",
    assets: [],
  };
}

let created = 0;
let skipped = 0;

for (const board of boards) {
  const dir = join(PKG_ROOT, board.boardDir);
  mkdirSync(dir, { recursive: true });

  const boardFile = join(dir, "board.json");
  if (existsSync(boardFile) && !force) {
    console.log(`· 跳过（已存在） ${board.boardDir}/board.json`);
    skipped++;
  } else {
    writeFileSync(boardFile, JSON.stringify(boardJson(board), null, 2) + "\n", "utf8");
    console.log(`✔ 创建 ${board.boardDir}/board.json`);
    created++;
  }

  if (isAssetBoard(board.id)) {
    const assetFile = join(dir, "asset-manifest.json");
    if (existsSync(assetFile) && !force) {
      console.log(`· 跳过（已存在） ${board.boardDir}/asset-manifest.json`);
      skipped++;
    } else {
      writeFileSync(assetFile, JSON.stringify(assetManifest(board), null, 2) + "\n", "utf8");
      console.log(`✔ 创建 ${board.boardDir}/asset-manifest.json`);
      created++;
    }
  }
}

console.log(`\n完成：新建 ${created} 个文件，跳过 ${skipped} 个（幂等）。`);
