#!/usr/bin/env node
/**
 * verify.mjs · 产物校验（阶段一：无产物时的降级行为）
 * ---------------------------------------------------------------------------
 * 作用：对 packaging/artifacts/ 下已有产物做「文件名合规 + SHA256 清单」校验，
 *      并把哈希写入 artifacts/SHA256SUMS.txt，供下载者核对。
 *
 * 用法：node packaging/scripts/verify.mjs
 * 退出码：0 = 通过；1 = 有产物但不合规；2 = 无产物（阶段一属正常）
 * ---------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
function walkFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue // 跳过 .staging-portable 等临时目录
      out.push(...walkFiles(full))
    }
    else if (e.name !== '.gitkeep' && !e.name.startsWith('.')) out.push(full)
  }
  return out
}

const ARTIFACTS = join(PKG_ROOT, "artifacts");

const dist = JSON.parse(readFileSync(join(PKG_ROOT, "distribution.json"), "utf8"));

/** 由 filePattern 推导校验用正则 */
function patternToRegex() {
  const p = dist.filePattern
    .replace(/[.]/g, "\\.")
    .replace("{form}", "(portable|setup|board)")
    .replace("{version}", "\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?")
    .replace("{date}", "\\d{8}")
    .replace("{arch}", "[a-z0-9]+")
    .replace("{ext}", "(?:zip|exe|msi|7z)");
  return new RegExp(`^${p}$`);
}

function sha256(file) {
  const h = createHash("sha256");
  h.update(readFileSync(file));
  return h.digest("hex");
}

if (!existsSync(ARTIFACTS)) {
  console.log("· artifacts/ 目录尚不存在 —— 阶段一不产出产物，属正常。");
  process.exit(2);
}

// 递归扫描：产物可能放在中文交付目录里（artifacts/交付/泽元-便携版-.../xxx.zip）
const files = walkFiles(ARTIFACTS)
  .map((p) => relative(ARTIFACTS, p).replace(/\\/g, "/"))
  .filter((rel) => /\.(zip|exe|msi|7z)$/i.test(rel));
if (files.length === 0) {
  console.log("· artifacts/ 下暂无产物 —— 阶段一不产出 exe/zip，属正常。");
  console.log("  阶段二出包后重跑本脚本即可得到 SHA256 清单。");
  process.exit(2);
}

const re = patternToRegex();
const rows = [];
let bad = 0;

for (const f of files) {
  const full = join(ARTIFACTS, f);
  const nameOk = re.test(basename(f));
  if (!nameOk) bad++;
  rows.push({ file: f, size: statSync(full).size, nameOk, sha256: sha256(full) });
}

console.log("产物校验：\n");
for (const r of rows) {
  console.log(`${r.nameOk ? "✅" : "❌"} ${r.file}`);
  console.log(`   大小 ${(r.size / 1024 / 1024).toFixed(2)} MB ｜ sha256 ${r.sha256}`);
  if (!r.nameOk) console.log(`   文件名不符合规则：${dist.filePattern}`);
}

if (bad === 0) {
  const sums = rows.map((r) => `${r.sha256}  ${basename(r.file)}`).join("\n") + "\n";
  writeFileSync(join(ARTIFACTS, "SHA256SUMS.txt"), sums, "utf8");
  // 交付目录里也放一份中文名校验文件，方便下载者核对
  const deliveryParent = join(ARTIFACTS, "交付");
  if (existsSync(deliveryParent)) {
    for (const d of readdirSync(deliveryParent, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      writeFileSync(
        join(deliveryParent, d.name, "SHA256校验.txt"),
        `校验方法（PowerShell）：Get-FileHash .\\<文件名> -Algorithm SHA256\\r\\n\\r\\n${sums}`,
        "utf8",
      );
    }
  }
  console.log(`\n✅ ${rows.length} 个产物全部合规，哈希已写入 artifacts/SHA256SUMS.txt 与交付目录/SHA256校验.txt`);
  process.exit(0);
}

console.log(`\n❌ ${bad} 个产物文件名不合规（应为 ${dist.filePattern}）`);
process.exit(1);
