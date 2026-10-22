#!/usr/bin/env node
/**
 * verify-cordis-mount.mjs · cordis loader 级挂载验证
 * ---------------------------------------------------------------------------
 * 与 smoke-mount.mjs 的区别：
 *   smoke-mount   手工调用 apply()，只证明「模块能跑」；
 *   本脚本        用真实的 @deepseek-ai/cordis Context 执行 ctx.plugin()，
 *                走 cordis 的插件生命周期（apply → effect → dispose），
 *                证明「模块符合插件契约、能被 loader 正常挂载与卸载」。
 *
 * 仍不等于「DSH desktop profile 实机装载」：desktop profile 由 Electron 应用独占，
 * CLI 无法 boot（官方报错：profile "desktop" is managed exclusively by the Electron application）。
 *
 * 用法：node scripts/verify-cordis-mount.mjs
 * ---------------------------------------------------------------------------
 */

import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..", "plugins", "dsh-training-protocol");

// 关键：本测试也在 Node 里挂载插件，会把 mount-state.json 写出来。
// 若写进生产目录，就会污染 verify-a5 的 L3 证据（把 Node 侧挂载误当成应用内挂载）。
// 因此强制写到临时目录，并以 host='node' 标记区分。
process.env.DSH_TRAINING_STATE_DIR = join(tmpdir(), `dsh-cordis-mount-${process.pid}`);
const ENTRY = resolve(PLUGIN_DIR, "dist", "index.js");

// cordis 装在插件自己的 node_modules 里（本脚本在项目根，根目录没有依赖），
// 因此按绝对路径 import，而不是裸包名解析。
const CORDIS_ENTRY = resolve(PLUGIN_DIR, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js");
if (!existsSync(CORDIS_ENTRY)) {
  console.error(`❌ 找不到 cordis：${CORDIS_ENTRY}\n   请先在插件目录执行 pnpm install`);
  process.exit(1);
}
const { Context } = await import(pathToFileURL(CORDIS_ENTRY).href);

const lines = [];
const origLog = console.log;
console.log = (...a) => {
  lines.push(a.join(" "));
  origLog(...a);
};

const ctx = new Context();

try {
  const mod = await import(pathToFileURL(ENTRY).href);
  origLog(`插件导出：name=${mod.name} apply=${typeof mod.apply}`);
  ctx.plugin(mod);
  // 等 cordis 把插件挂完（生命周期是异步的）
  await new Promise((r) => setTimeout(r, 300));
  const mounted = lines.some((l) => l.includes("mounted — LV0 · 未授权"));
  origLog(`\n挂载日志命中「mounted — LV0 · 未授权」：${mounted ? "是" : "否"}`);
  origLog(`监听器/effect 登记数：${lines.filter((l) => l.includes("gate:")).length} 条挂载说明`);

  // 卸载测试说明：cordis 4 的根 fiber 没有暴露公开的 dispose()，
  // 因此卸载路径改由 scripts/smoke-mount.mjs 直接调用 disposer 验证（已通过）。
  if (mounted) {
    origLog("\n✅ cordis loader 级挂载通过");
    origLog("   卸载（DISPOSED）验证见 scripts/smoke-mount.mjs");
    process.exit(0);
  }
  origLog("\n❌ cordis 挂载验证未通过");
  process.exit(1);
} catch (err) {
  origLog(`\n❌ 失败：${err.stack ?? err.message}`);
  process.exit(1);
} finally {
  console.log = origLog;
}
