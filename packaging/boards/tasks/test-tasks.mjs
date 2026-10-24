#!/usr/bin/env node
// tasks 板块 smoke（契约 v2 硬要求：每个板块必带）
// 断言框架见 ../../scripts/board-smoke-lib.mjs
import { runBoardSmoke } from '../../scripts/board-smoke-lib.mjs'
await runBoardSmoke('tasks')
