#!/usr/bin/env node
/**
 * test-license.mjs · License 体系测试（A6 的四条核心用例 + 边界）
 * ---------------------------------------------------------------------------
 * A6 要求：未签→拒 / 已签→过 / 过期→拒 / 篡改→拒。
 * 本脚本对**构建产物 dist/license.js** 做真实 HMAC 验签测试，不做任何 mock。
 *
 * 用法：node packaging/scripts/test-license.mjs
 * 退出码：0 = 全部通过
 * ---------------------------------------------------------------------------
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DIST = join(REPO, "plugins", "dsh-training-protocol", "dist");

// 独立 state 目录（必须在 import 之前设置，模块在调用时读取 env）
const STATE = mkdtempSync(join(tmpdir(), "dsh-license-test-"));
process.env.DSH_TRAINING_STATE_DIR = STATE;

const { evaluateLicense, issueLicense, checkOnDisk, readLicense, loadKey, keyPath, licensePath, REQUIRED_SCOPE } =
  await import(join(DIST, "license.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}  → 实际 ${actual}${ok ? "" : `，期望 ${expected}`}`);
  ok ? pass++ : fail++;
}

function reset() {
  rmSync(licensePath(), { force: true });
  rmSync(keyPath(), { force: true });
}

const KEY = () => loadKey();
const now = new Date("2026-10-23T12:00:00.000Z");

try {
  // ---------- A6-1 未签署 → 拒 ----------
  console.log("=== A6-1 · 未签署（无 License）→ 拒绝 ===");
  reset();
  const c1 = checkOnDisk(now);
  check("错误码", c1.code, "E-601");
  check("不可进 LV1", c1.ok, false);
  check("checks.exists", c1.checks.exists, false);
  console.log(`   文案：${c1.reason}`);

  // ---------- A6-2 正常签署 → 通过 ----------
  console.log("\n=== A6-2 · 正常签署 → 通过 ===");
  const lic = issueLicense({ subject: "测试学员", days: 30, now });
  check("产生了密钥", /^[0-9a-f]{64}$/i.test(KEY() ?? ""), true);
  const c2 = checkOnDisk(now);
  check("错误码", c2.code, "OK");
  check("可进 LV1", c2.ok, true);
  check("验签通过", c2.checks.signature, true);
  check("未过期", c2.checks.notExpired, true);
  check("scope 覆盖", c2.checks.scope, true);
  check("磁盘上能读回", readLicense()?.subject, "测试学员");

  // ---------- A6-3 过期 → 拒 ----------
  console.log("\n=== A6-3 · 已过期 → 拒绝 ===");
  const later = new Date(Date.parse(lic.expiresAt) + 1000);
  const c3 = checkOnDisk(later);
  check("错误码", c3.code, "E-603");
  check("不可进 LV1", c3.ok, false);
  console.log(`   文案：${c3.reason}`);

  // ---------- A6-4 篡改 → 拒 ----------
  console.log("\n=== A6-4 · 篡改内容 → 拒绝 ===");
  const tampered = { ...lic, subject: "黑客同学" };
  const c4 = evaluateLicense(tampered, KEY(), now);
  check("改 subject 后错误码", c4.code, "E-602");
  const forged = { ...lic, expiresAt: "2099-01-01T00:00:00.000Z" };
  const c5 = evaluateLicense(forged, KEY(), now);
  check("改有效期后错误码", c5.code, "E-602");
  const badSig = { ...lic, signature: "0".repeat(64) };
  const c6 = evaluateLicense(badSig, KEY(), now);
  check("伪造签名后错误码", c6.code, "E-602");

  // ---------- 边界：scope 不足 / 缺密钥 / 格式非法 / 到期瞬间 ----------
  console.log("\n=== 边界用例 ===");
  const narrow = issueLicense({ subject: "只读学员", days: 10, scopes: ["training:review"], now });
  const c7 = evaluateLicense(narrow, KEY(), now);
  check("scope 不含 playground → E-604", c7.code, "E-604");
  check("E-604 时 ok=false", c7.ok, false);

  const c8 = evaluateLicense(lic, null, now);
  check("缺密钥 → E-606", c8.code, "E-606");

  const broken = { ...lic };
  delete broken.expiresAt;
  const c9 = evaluateLicense(broken, KEY(), now);
  check("缺字段 → E-605", c9.code, "E-605");

  const atExpiry = evaluateLicense(lic, KEY(), new Date(Date.parse(lic.expiresAt)));
  check("到期瞬间即拒绝（边界）", atExpiry.code, "E-603");

  const skewed = evaluateLicense({ ...lic, version: 999 }, KEY(), now);
  check("版本不匹配 → E-605", skewed.code, "E-605");

  // ---------- 落盘一致性 ----------
  console.log("\n=== 落盘一致性 ===");
  const raw = JSON.parse(readFileSync(licensePath(), "utf8"));
  check("license.json 含 signature", /^[0-9a-f]{64}$/i.test(raw.signature), true);
  // 此处落盘的是上面那张"只读 scope"的 License，验签/时效应通过，scope 应被单独判 E-604
check("签名可复算一致（不校验 scope）", evaluateLicense(raw, KEY(), now, null).code, "OK");
check("同一张 License 按默认 scope 判定则拒绝", evaluateLicense(raw, KEY(), now).code, "E-604");
  check("state 目录存在", existsSync(STATE), true);
  mkdirSync(STATE, { recursive: true });
} finally {
  rmSync(STATE, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
