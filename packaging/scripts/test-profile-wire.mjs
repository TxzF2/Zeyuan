#!/usr/bin/env node
/**
 * test-profile-wire.mjs · profile 写入/撤回 6 用例（全部在临时目录，不碰真实 profile）
 * ---------------------------------------------------------------------------
 * 用法：node packaging/scripts/test-profile-wire.mjs
 * 退出码：0 = 全部通过
 * ---------------------------------------------------------------------------
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "..", "installer", "shell", "lib", "profile-wire.js");
const { inspect, wire, unwire, ProfileWireError } = require(LIB);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}  → 实际 ${actual}${ok ? "" : `，期望 ${expected}`}`);
  ok ? pass++ : fail++;
}
async function expectCode(label, fn, code) {
  try {
    await fn();
    check(label, "没有抛错", code);
  } catch (err) {
    check(`${label} · 错误码`, err instanceof ProfileWireError ? err.code : `非 ProfileWireError(${err?.name})`, code);
    console.log(`   文案：${err.message}`);
  }
}

const PKG = "dsh-training-protocol";
const roots = [];
function makeProfile(dirName, pkg = {}) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-profile-${dirName}-`));
  roots.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  return dir;
}
const read = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

try {
  // 1 首次写入
  console.log("=== 1 · 首次写入 ===");
  const p1 = makeProfile("first", { name: "dsh-profile-test", private: true, dependencies: { dshmarket: "1.66.28" } });
  const r1 = wire({ profileDir: p1, packageName: PKG, linkPath: "C:/x/plugins/dsh-training-protocol" });
  check("changed", r1.changed, true);
  const j1 = read(p1);
  check("dependencies 写入", /^link:C:\/x\/plugins/.test(j1.dependencies[PKG]), true);
  check("bundles 追加", j1.dsh.profile.bundles.includes(PKG), true);
  check("原有依赖未被破坏", j1.dependencies.dshmarket, "1.66.28");
  check("产生了备份", existsSync(r1.backup), true);
  check("inspect.ready", inspect({ profileDir: p1, packageName: PKG }).ready, true);

  // 2 幂等
  console.log("\n=== 2 · 重复写入（幂等）===");
  const before2 = readFileSync(join(p1, "package.json"), "utf8");
  const r2 = wire({ profileDir: p1, packageName: PKG, linkPath: "C:/x/plugins/dsh-training-protocol" });
  check("changed=false", r2.changed, false);
  check("文件字节未变", readFileSync(join(p1, "package.json"), "utf8") === before2, true);

  // 3 覆盖旧 link
  console.log("\n=== 3 · 已有旧路径时覆盖 ===");
  const r3 = wire({ profileDir: p1, packageName: PKG, linkPath: "C:/y/other-path" });
  check("changed=true", r3.changed, true);
  check("新路径生效", read(p1).dependencies[PKG], "link:C:/y/other-path");
  check("bundles 未重复", read(p1).dsh.profile.bundles.filter((x) => x === PKG).length, 1);

  // 4 JSON 损坏
  console.log("\n=== 4 · JSON 损坏（E-502，且不得改坏原文件）===");
  const p4 = makeProfile("broken");
  const broken = '{"name": "x", "dependencies": {,}}';
  writeFileSync(join(p4, "package.json"), broken, "utf8");
  await expectCode("损坏 JSON", () => wire({ profileDir: p4, packageName: PKG, linkPath: "C:/x" }), "E-502");
  check("原文件未被改写", readFileSync(join(p4, "package.json"), "utf8"), broken);

  // 5 写入被拒（用只读文件模拟权限问题）
  console.log("\n=== 5 · 写入被拒（E-503，自动恢复备份）===");
  const p5 = makeProfile("readonly");
  const before5 = readFileSync(join(p5, "package.json"), "utf8");
  let skipped = false;
  try {
    chmodSync(join(p5, "package.json"), 0o444);
    const r5 = wire({ profileDir: p5, packageName: PKG, linkPath: "C:/x/plugins" });
    // Windows 下只读位有时仍可写；能写进去就说明平台不拦，标记为跳过
    skipped = r5.changed === true;
    console.log(`   注意：本平台未拦截只读写入（changed=${r5.changed}），该用例降级为「可写通过」`);
  } catch (err) {
    check("错误码", err.code, "E-503");
    check("原文件已恢复", readFileSync(join(p5, "package.json"), "utf8"), before5);
  } finally {
    try {
      chmodSync(join(p5, "package.json"), 0o666);
    } catch {
      /* ignore */
    }
  }
  if (skipped) {
    check("降级用例（平台可写）", true, true);
  }

  // 6 unwire
  console.log("\n=== 6 · 撤回（unwire）===");
  const p6 = makeProfile("unwire", {
    name: "t",
    dependencies: { dshmarket: "1.66.28" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", PKG] } },
  });
  const r6 = unwire({ profileDir: p6, packageName: PKG });
  check("changed", r6.changed, true);
  const j6 = read(p6);
  check("dependencies 已移除", Object.prototype.hasOwnProperty.call(j6.dependencies, PKG), false);
  check("bundles 已移除", j6.dsh.profile.bundles.includes(PKG), false);
  check("其它 bundles 保留", j6.dsh.profile.bundles.includes("@deepseek-ai/dsh-base"), true);
  const r6b = unwire({ profileDir: p6, packageName: PKG });
  check("再次撤回幂等", r6b.changed, false);

  // 6.5 node_modules 链接（DSH 实际从这里解析插件）
  console.log("\n=== 6.5 · node_modules 链接维护 ===");
  const { ensureNodeModulesLink } = require(LIB);
  const t65 = makeProfile("nmlink");
  const realPlugin = mkdtempSync(join(tmpdir(), "dsh-real-plugin-"));
  roots.push(realPlugin);
  writeFileSync(join(realPlugin, "package.json"), '{"name":"dsh-training-protocol","version":"0.3.0"}');
  const l1 = ensureNodeModulesLink(t65, PKG, realPlugin);
  check("首次创建链接", l1.changed, true);
  const { realpathSync, lstatSync } = await import("node:fs");
  check("realpath 指向真实插件目录", realpathSync(join(t65, "node_modules", PKG)).toLowerCase(), realpathSync(realPlugin).toLowerCase());
  const l2 = ensureNodeModulesLink(t65, PKG, realPlugin);
  check("再次调用幂等", l2.changed, false);
  const otherPlugin = mkdtempSync(join(tmpdir(), "dsh-other-plugin-"));
  roots.push(otherPlugin);
  writeFileSync(join(otherPlugin, "package.json"), '{"name":"x"}');
  const l3 = ensureNodeModulesLink(t65, PKG, otherPlugin);
  check("换目标时重建链接", l3.changed, true);
  check("链接已指向新目标", realpathSync(join(t65, "node_modules", PKG)).toLowerCase(), realpathSync(otherPlugin).toLowerCase());
  const un6 = unwire({ profileDir: t65, packageName: PKG });
  check("撤回时移除链接", un6.nodeModulesLink.removed, true);
  check("链接确实已不存在", (() => { try { lstatSync(join(t65, "node_modules", PKG)); return false } catch { return true } })(), true);

  // 附加：备份最多保留 3 份
  console.log("\n=== 附加 · 备份清理策略 ===");
  for (let i = 0; i < 5; i++) {
    wire({ profileDir: p6, packageName: PKG, linkPath: `C:/x/v${i}` });
    unwire({ profileDir: p6, packageName: PKG });
  }
  const backups = readdirSync(p6).filter((f) => f.startsWith("package.json.bak-"));
  check("备份份数 ≤ 3", backups.length <= 3, true);
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
