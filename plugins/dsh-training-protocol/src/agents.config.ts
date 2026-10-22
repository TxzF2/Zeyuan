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
 * ---------------------------------------------------------------------------
 */

/** agent 接入类型 */
export type AgentKind =
  | 'llm' // 直接走模型的对话型 agent
  | 'mcp' // 经 MCP server 暴露能力的 agent
  | 'plugin' // 由 DSH 插件承载的 agent
  | 'custom' // 其他/自研接入

/** agent 在培训班里可承担的职责 */
export type AgentRole =
  | 'guide' // 引导（对应星辰 TxzF 的开场/指路位）
  | 'trainer' // 陪练（实训场对话）
  | 'reviewer' // 复盘（对应长征姬的错题/考核位）
  | 'evaluator' // 评分

/** agent 能力开关 */
export type AgentCapability = 'chat' | 'playground' | 'quiz-review' | 'code-run' | 'file-io'

/** 单个 agent 的适配配置 */
export interface AgentAdapterConfig {
  /** 唯一 id，建议 kebab-case，与目录名一致 */
  id: string
  /** 展示名（Web UI 上显示） */
  displayName: string
  kind: AgentKind
  /** 是否启用；false 时 loadEnabledAgents() 会过滤掉 */
  enabled: boolean
  /** 接入地址：http(s) 或本地路径；MCP 为 server 名 */
  endpoint?: string
  /** 模型标识（kind=llm 时必填，其余可选） */
  model?: string
  /** 可承担的职责 */
  roles?: AgentRole[]
  /** 能力开关 */
  capabilities?: AgentCapability[]
  /** 备注：接入须知、限流、密钥来源等（不要写明文密钥） */
  notes?: string
}

/**
 * 适配 agent 列表 —— **在此处补充**。
 *
 * 补充时的最小合法条目示例（仅示意，不要留假数据）：
 *
 *   { id: 'example-agent', displayName: '示例 Agent', kind: 'llm',
 *     enabled: false, model: '<model-id>', roles: ['trainer'], capabilities: ['chat'] }
 *
 * 注意：
 *   1. 未确认可用的 agent 一律 enabled: false，避免运行时去连不存在的端点；
 *   2. endpoint / model 留空表示「走 DSH 当前默认模型」；
 *   3. 严禁在本文件写 API Key —— 密钥走 DSH 凭据体系。
 */
export const AGENTS_CONFIG: readonly AgentAdapterConfig[] = [] as const

/** 配置校验问题 */
export interface ConfigIssue {
  /** 出问题的条目定位，如 agents[0].id */
  path: string
  message: string
}

const KINDS: readonly AgentKind[] = ['llm', 'mcp', 'plugin', 'custom']
const ROLES: readonly AgentRole[] = ['guide', 'trainer', 'reviewer', 'evaluator']
const CAPABILITIES: readonly AgentCapability[] = ['chat', 'playground', 'quiz-review', 'code-run', 'file-io']

/**
 * 校验配置，返回问题列表（空数组 = 合法）。
 * 纯函数，无副作用，便于单测与启动期自检。
 */
export function validateAgents(list: readonly AgentAdapterConfig[] = AGENTS_CONFIG): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const seen = new Set<string>()

  list.forEach((a, i) => {
    const at = `agents[${i}]`
    if (!a || typeof a !== 'object') {
      issues.push({ path: at, message: '条目不是对象' })
      return
    }
    if (!a.id || !/^[a-z0-9][a-z0-9-]*$/.test(a.id)) {
      issues.push({ path: `${at}.id`, message: '缺少 id 或格式非法（要求小写 kebab-case）' })
    } else if (seen.has(a.id)) {
      issues.push({ path: `${at}.id`, message: `id 重复：${a.id}` })
    } else {
      seen.add(a.id)
    }
    if (!a.displayName) issues.push({ path: `${at}.displayName`, message: '缺少展示名' })
    if (!KINDS.includes(a.kind)) issues.push({ path: `${at}.kind`, message: `kind 必须是 ${KINDS.join('/')}` })
    if (typeof a.enabled !== 'boolean') issues.push({ path: `${at}.enabled`, message: 'enabled 必须是布尔值' })
    if (a.kind === 'llm' && !a.model && !a.endpoint) {
      issues.push({ path: `${at}`, message: 'kind=llm 时必须给 model 或 endpoint（两者都空会退回默认模型，需显式确认）' })
    }
    for (const r of a.roles ?? []) {
      if (!ROLES.includes(r)) issues.push({ path: `${at}.roles`, message: `未知职责：${r}` })
    }
    for (const c of a.capabilities ?? []) {
      if (!CAPABILITIES.includes(c)) issues.push({ path: `${at}.capabilities`, message: `未知能力：${c}` })
    }
    if (a.notes && /(sk-|api[_-]?key\s*[:=])/i.test(a.notes)) {
      issues.push({ path: `${at}.notes`, message: 'notes 中疑似包含密钥，请移除（密钥走 DSH 凭据体系）' })
    }
  })

  return issues
}

/** 过滤出启用的 agent；配置非法时**不抛异常**，仅剔除该条并回传问题 */
export function loadEnabledAgents(
  list: readonly AgentAdapterConfig[] = AGENTS_CONFIG,
): { agents: AgentAdapterConfig[]; issues: ConfigIssue[] } {
  const issues = validateAgents(list)
  const badIds = new Set(issues.map((i) => i.path.replace(/^agents\[\d+\]\.?/, '').split('.')[0]))
  const agents = list.filter((a) => a.enabled && !badIds.has(a.id))
  return { agents, issues }
}
