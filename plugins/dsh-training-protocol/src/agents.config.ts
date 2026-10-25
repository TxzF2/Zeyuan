/**
 * dsh-training-protocol · 适配 agent 列表（配置驱动）
 * ---------------------------------------------------------------------------
 * 设计原则：**列表只放数据，不放代码**。
 * 后续补充 agent 时，只允许在本文件的 AGENTS_CONFIG 数组里加条目，
 * 不允许为某个 agent 写分支逻辑（否则违反「板块间低耦合」原则）。
 *
 * 当前状态：列表**暂缺**（你标注为「后续补充」），数组为空。
 * 空数组是合法状态 —— validateAgents([]) 返回空错误列表，
 * loadEnabledAgents() 返回 []，插件照常挂载，不会因缺配置而崩溃。
 *
 * 字段口径（按 1.1 指令）：**name / source / role**
 * ---------------------------------------------------------------------------
 */

/** agent 在泽元里承担的职责 */
export type AgentRole =
  | 'guide' // 引导（对应星辰 TxzF 的开场/指路位）
  | 'trainer' // 陪练（实训场对话）
  | 'reviewer' // 复盘（对应长征姬的错题/考核位）
  | 'evaluator' // 评分

/** 单个 agent 的适配配置 */
export interface AgentAdapterConfig {
  /** 展示名，也是唯一标识（要求非空且不重复） */
  name: string
  /**
   * 来源。四种合法形态：
   *   npm 包名      → 'dsh-plugin-xxx' / '@scope/dsh-xxx'
   *   MCP server    → 'mcp:<server-name>'
   *   HTTP 端点     → 'https://…'
   *   板块资源      → 'board:<board-id>'（指向 packaging/boards 下的板块资源）
 *   占位（待定）  → 'todo:<name>'（显式标记「来源未定」）
   */
  source: string
  /** 职责 */
  role: AgentRole
  /** 是否启用，默认 true；未确认可用时显式写 false */
  enabled?: boolean
  /** 备注：接入须知、限流说明等（**不要写明文密钥**） */
  note?: string
}

/**
 * 适配 agent 列表 —— **在此处补充**。
 *
 * 最小合法条目示例（仅示意，不要留假数据）：
 *
 *   { name: '示例 Agent', source: 'mcp:example-server', role: 'trainer', enabled: false }
 *   { name: '示例 Agent', source: 'dsh-plugin-example', role: 'guide' }
 *   { name: '示例 Agent', source: 'https://example.com/v1', role: 'reviewer', enabled: false }
 *
 * 注意：
 *   1. 未确认可用的 agent 一律 `enabled: false`，避免运行时去连不存在的来源；
 *   2. 严禁在本文件写 API Key —— 密钥走 DSH 凭据体系；
 *   3. 改完本文件需 `pnpm build`，随后重启 DSH 生效。
 */
export const AGENTS_CONFIG: readonly AgentAdapterConfig[] = [
  {
    name: '星辰（TxzF）',
    source: 'board:character-txzf',
    role: 'guide',
    enabled: false,
    note: '男性引导角色（星辰/路鸣泽风格）：开场引导与关卡提示。资源已挂入板块 character-txzf（FBX + 骨骼 + 6 动作），enabled:false 待接运行时适配器。',
  },
  {
    name: '长征姬',
    source: 'board:character-changzhengji',
    role: 'reviewer',
    enabled: false,
    note: '长征主题高冷御姐：纪律考核与错题复盘。资源已挂入板块 character-changzhengji（FBX + 骨架 + 5 动作），enabled:false 待接运行时适配器。',
  },
] as const

/** 配置校验问题 */
export interface ConfigIssue {
  /** 出问题的条目下标 */
  index: number
  /** 出问题的字段名 */
  field: string
  message: string
}

const ROLES: readonly AgentRole[] = ['guide', 'trainer', 'reviewer', 'evaluator']

/** source 合法性：npm 包名 / mcp:server / https 端点 / todo: 占位 */
function isValidSource(source: string): boolean {
  if (!source) return false
  // 占位形态：显式声明「来源未定」。配 enabled:false 使用，不会被加载。
  if (source.startsWith('todo:')) return source.length > 5
  // 板块资源（角色/主题）：board:<board-id>
  if (source.startsWith('board:')) return /^[a-z][a-z0-9-]*$/.test(source.slice(6))
  if (source.startsWith('mcp:')) return source.length > 4
  if (/^https?:\/\//i.test(source)) {
    try {
      new URL(source)
      return true
    } catch {
      return false
    }
  }
  // npm 包名（含 scope）
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(source)
}

/**
 * 校验配置，返回问题列表（空数组 = 合法）。
 * 纯函数、无副作用，便于启动期自检与单测。
 */
export function validateAgents(list: readonly AgentAdapterConfig[] = AGENTS_CONFIG): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const seen = new Set<string>()

  list.forEach((a, index) => {
    if (!a || typeof a !== 'object') {
      issues.push({ index, field: '(entry)', message: '条目不是对象' })
      return
    }
    if (!a.name || typeof a.name !== 'string' || !a.name.trim()) {
      issues.push({ index, field: 'name', message: '缺少 name（展示名即唯一标识）' })
    } else if (seen.has(a.name)) {
      issues.push({ index, field: 'name', message: `name 重复：${a.name}` })
    } else {
      seen.add(a.name)
    }
    if (!isValidSource(a.source)) {
      issues.push({
        index,
        field: 'source',
        message: `source 非法：${String(a.source)}（允许 npm 包名 / mcp:<server> / https://… / board:<id> / todo:<name>）`,
      })
    }
    if (!ROLES.includes(a.role)) {
      issues.push({ index, field: 'role', message: `role 必须是 ${ROLES.join(' / ')}` })
    }
    if (a.enabled !== undefined && typeof a.enabled !== 'boolean') {
      issues.push({ index, field: 'enabled', message: 'enabled 必须是布尔值' })
    }
    if (a.note && /(sk-|api[_-]?key\s*[:=]|bearer\s+[a-z0-9])/i.test(a.note)) {
      issues.push({ index, field: 'note', message: 'note 中疑似包含密钥，请移除（密钥走 DSH 凭据体系）' })
    }
  })

  return issues
}

/**
 * 过滤出启用的 agent。
 * 配置非法时**不抛异常**：把出问题的条目整条剔除，并把问题回传给调用方打日志。
 *
 * 重名处理：name 重复属于配置歧义（无法判断该用哪条），因此**同名的所有条目整组剔除**，
 * 而不是「留第一条」——静默保留会让配置错误被隐藏。
 */
export function loadEnabledAgents(
  list: readonly AgentAdapterConfig[] = AGENTS_CONFIG,
): { agents: AgentAdapterConfig[]; issues: ConfigIssue[] } {
  const issues = validateAgents(list)
  const badIndexes = new Set(issues.map((i) => i.index))

  const nameCounts = new Map<string, number>()
  for (const a of list) {
    if (a && typeof a.name === "string") nameCounts.set(a.name, (nameCounts.get(a.name) ?? 0) + 1)
  }

  const agents = list.filter(
    (a, index) =>
      !badIndexes.has(index) && (nameCounts.get(a?.name) ?? 0) <= 1 && a?.enabled !== false,
  )
  return { agents, issues }
}
