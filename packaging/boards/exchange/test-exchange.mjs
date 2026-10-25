#!/usr/bin/env node
// exchange 板块 smoke（契约 v2 硬要求：每个板块必带）
import { runBoardSmoke } from '../../scripts/board-smoke-lib.mjs'
await runBoardSmoke('exchange')
