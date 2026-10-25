/**
 * auth.ts · 下载/删除鉴权 hook（P0）
 * ---------------------------------------------------------------------------
 * 默认实现先写**最严**的部分：删除只允许上传者本人。
 * 下载在 P0 保持开放（用户拍板：只收紧删除）。
 *
 * 未定项一律标 TODO(总控裁决)，**不写死**：
 *   - P6/管理删除
 *   - 分享链接 / 板块可见性 / 同学互看
 * ---------------------------------------------------------------------------
 */

import type { FileMeta } from './meta.js'

export type NodeId = string

export interface Authz {
  canDownload(viewer: NodeId, meta: FileMeta): boolean | Promise<boolean>
  canDelete(viewer: NodeId, meta: FileMeta): boolean | Promise<boolean>
}

export class AuthError extends Error {
  readonly status = 403
  readonly code = 'E-1502'
  constructor(message = '无权操作该文件') {
    super(message)
    this.name = 'AuthError'
  }
}

export const defaultAuthz: Authz = {
  // P0：列表/下载开放（匿名中转的初衷）；可见性策略 TODO(总控裁决)
  canDownload: () => true,
  // P0：仅上传者本人可删；P6/管理删除 TODO(总控裁决)
  canDelete: (viewer, meta) => viewer === meta.uploader,
}

export async function assertCanDownload(authz: Authz, viewer: NodeId, meta: FileMeta): Promise<void> {
  if (!(await authz.canDownload(viewer, meta))) throw new AuthError('无权下载该文件')
}

export async function assertCanDelete(authz: Authz, viewer: NodeId, meta: FileMeta): Promise<void> {
  if (!(await authz.canDelete(viewer, meta))) throw new AuthError('只能删除自己上传的文件')
}
