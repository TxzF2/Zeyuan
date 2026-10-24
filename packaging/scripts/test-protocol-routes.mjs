#!/usr/bin/env node
/**
 * test-protocol-routes.mjs · 协议页 HTTP 接口测试（面板真正调用的那几条）
 * ---------------------------------------------------------------------------
 * 做法：造一个最小 ctx（effect + webServer.register），调用插件的 apply()，
 *      截获注册的路由，再用手工 req/res 触发它们——不依赖 DSH 应用。
 *
 * 覆盖：GET state（未签→LV0/E-601）、POST sign（缺 confirm→E-607）、
 *      POST sign（确认→LV1）、GET state（LV1）、POST revoke（回 LV0）。
 *
 * 用法：node packaging/scripts/test-protocol-routes.mjs
 * 退出码：0 = 全部通过
 * ---------------------------------------------------------------------------
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DIST = join(REPO, "plugins", "dsh-training-protocol", "dist", "index.js");

const STATE = mkdtempSync(join(tmpdir(), "dsh-routes-test-"));
process.env.DSH_TRAINING_STATE_DIR = STATE;

const mod = await import(`file:///${DIST.replace(/\\/g, "/")}`);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}  → 实际 ${actual}${ok ? "" : `，期望 ${expected}`}`);
  ok ? pass++ : fail++;
}

/** 截获路由 */
const routes = new Map();
const fakeWebServer = {
  register(spec) {
    routes.set(spec.path, spec.handler);
    return () => routes.delete(spec.path);
  },
};
const disposers = [];
const ctx = {
  effect(fn, _label) {
    const d = fn();
    if (typeof d === "function") disposers.push(d);
    return d;
  },
  on() {},
  webServer: fakeWebServer,
};

/** 造 res */
function makeRes() {
  const out = { status: 0, headers: null, body: null };
  out.writeHead = (code, headers) => {
    out.status = code;
    out.headers = headers;
  };
  out.end = (buf) => {
    out.body = buf ? JSON.parse(buf.toString("utf8")) : null;
  };
  return out;
}

/** 造 req（可选 JSON body） */
function makeReq(body) {
  const listeners = {};
  const req = {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return req;
    },
  };
  // 下一 tick 触发，模拟真实流
  setImmediate(() => {
    const text = body ? JSON.stringify(body) : "";
    for (const cb of listeners["data"] ?? []) if (text) cb(Buffer.from(text, "utf8"));
    for (const cb of listeners["end"] ?? []) cb();
  });
  return req;
}

async function call(path, body) {
  const handler = routes.get(path);
  if (!handler) throw new Error(`路由未注册：${path}`);
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

try {
  console.log("=== 挂载插件（假 webServer）===");
  mod.apply(ctx);
  check("注册路由数", routes.size, 4);
  check(
    "路由清单",
    [...routes.keys()].sort().join("|"),
    [
      "/dsh-training/protocol/revoke",
      "/dsh-training/protocol/sign",
      "/dsh-training/protocol/state",
      "/dsh-training/protocol/verify",
    ]
      .sort()
      .join("|"),
  );

  console.log("\n=== 场景 1 · 未签署 → LV0 / E-601 ===");
  const s1 = await call("/dsh-training/protocol/state");
  check("HTTP 200", s1.status, 200);
  check("level", s1.body.level, "LV0");
  check("check.code", s1.body.check.code, "E-601");
  check("license 为空", s1.body.license, null);
  console.log(`   文案：${s1.body.check.reason}`);

  console.log("\n=== 场景 2 · 签发缺 confirm → E-607 ===");
  const s2 = await call("/dsh-training/protocol/sign", { days: 30 });
  check("HTTP 400", s2.status, 400);
  check("错误码", s2.body.code, "E-607");

  console.log("\n=== 场景 3 · 确认签发 → LV1 ===");
  const s3 = await call("/dsh-training/protocol/sign", { confirm: true, subject: "接口测试学员", days: 30 });
  check("HTTP 200", s3.status, 200);
  check("level 变 LV1", s3.body.level, "LV1");
  check("返回 license 摘要", typeof s3.body.license?.signatureShort, "string");

  const s4 = await call("/dsh-training/protocol/state");
  check("state 复查 level", s4.body.level, "LV1");
  check("check.code", s4.body.check.code, "OK");
  check("四项校验全过", Object.values(s4.body.check.checks).every(Boolean), true);
  check("license subject", s4.body.license.subject, "接口测试学员");

  console.log("\n=== 场景 4 · verify 路由 ===");
  const s5 = await call("/dsh-training/protocol/verify", {});
  check("verify ok", s5.body.ok, true);
  check("verify level", s5.body.level, "LV1");

  console.log("\n=== 场景 5 · 吊销 → 回 LV0 ===");
  const s6 = await call("/dsh-training/protocol/revoke", {});
  check("吊销 removed", s6.body.removed, true);
  check("吊销后 level", s6.body.level, "LV0");
  const s7 = await call("/dsh-training/protocol/state");
  check("复查 level", s7.body.level, "LV0");
  check("复查 code", s7.body.check.code, "E-601");

  console.log("\n=== 场景 6 · 注入型 ctx（模拟 DSH：apply 时无 webServer）===");
  const routes2 = new Map();
  const injectedDeps = [];
  const ctx2 = {
    effect(fn) {
      return fn();
    },
    on() {},
    inject(deps, cb) {
      injectedDeps.push(deps.join(","));
      // 模拟"服务稍后就绪"
      cb({
        effect: ctx2.effect,
        webServer: {
          register(spec) {
            routes2.set(spec.path, spec.handler);
            return () => {};
          },
        },
      });
    },
  };
  mod.apply(ctx2);
  check("声明了 inject(['webServer'])", injectedDeps[0], "webServer");
  check("注入就绪后注册路由数", routes2.size, 4);

  console.log("\n=== 卸载清理 ===");
  for (const d of disposers) d();
  console.log(`   已执行 ${disposers.length} 个 disposer`);
  check("disposer 数量 ≥ 2", disposers.length >= 2, true);
} finally {
  rmSync(STATE, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
