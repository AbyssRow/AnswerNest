import type { AIModel, AIPlatform } from './modelConfig'

/**
 * 早期版本启动时会从原作者的服务器同步一份「远程目录」（平台、模型、图标、邀请码），
 * 这些平台被标成 isRemote、不能编辑也不能删除。现在不再同步，所以把已经存下来的远程平台转成普通的本地平台：
 * - 填过 API Key，或者在里面加过自己的模型：保留，并解除只读限制
 * - 既没填 Key 也没有自己的模型：说明用户从没用过它，直接清掉
 * - 去掉原作者的邀请码 / 邀请文案，以及指向原作者服务器的图标文件名
 *
 * 不依赖任何运行环境，方便单元测试。已经是本地的平台不会被改动（除了失效的图标引用）。
 */
export interface RemoteCatalogMigrationResult {
  platforms: AIPlatform[]
  changed: boolean
  removedPlatformIds: string[]
}

/** 相对路径的图标（如 openai.svg）原本解析到原作者的服务器；http(s) 地址和 emoji 是用户自己选的，保留 */
const isStaleIconReference = (icon?: string): boolean => {
  if (!icon) return false
  if (/^(https?:|data:)/i.test(icon)) return false
  return icon.includes('.')
}

const cleanModel = (model: AIModel): AIModel => {
  const next: AIModel = { ...model, isRemote: false }
  if (isStaleIconReference(next.icon)) next.icon = undefined
  return next
}

export function adoptRemotePlatforms(platforms: AIPlatform[]): RemoteCatalogMigrationResult {
  let changed = false
  const removedPlatformIds: string[] = []
  const result: AIPlatform[] = []

  for (const platform of platforms) {
    const isRemote = platform.isRemote === true || (platform.models || []).some(model => model.isRemote === true)
    const hasStaleIcon = isStaleIconReference(platform.icon) || (platform.models || []).some(model => isStaleIconReference(model.icon))

    if (!isRemote && !hasStaleIcon) {
      result.push(platform)
      continue
    }

    if (isRemote) {
      const hasKey = !!platform.apiKey?.trim()
      const hasOwnModels = (platform.models || []).some(model => !model.isRemote)
      if (!hasKey && !hasOwnModels) {
        removedPlatformIds.push(platform.id)
        changed = true
        continue
      }
    }

    const { inviteUrl: _inviteUrl, inviteText: _inviteText, inviteCode: _inviteCode, ...rest } = platform
    const next: AIPlatform = {
      ...rest,
      isRemote: false,
      models: (platform.models || []).map(cleanModel),
    }
    if (isStaleIconReference(next.icon)) next.icon = undefined
    result.push(next)
    changed = true
  }

  return { platforms: result, changed, removedPlatformIds }
}
