/** 旧版模型只有显示名和上游 ID；补齐名称，同时保留已有字段与内部 ID。 */
export function normalizeModelNames<T extends { id?: unknown; name?: unknown; displayName?: unknown; modelId?: unknown }>(model: T): T {
  const text = (...values: unknown[]): string => {
    const value = values.find(value => typeof value === 'string' && value.trim())
    return typeof value === 'string' ? value.trim() : ''
  }
  const missing = (value: unknown) => value == null || (typeof value === 'string' && !value.trim())
  const name = text(model.name, model.modelId, model.displayName, model.id)
  return {
    ...model,
    ...(missing(model.name) && name ? { name } : {}),
    ...(missing(model.displayName) && name ? { displayName: name } : {})
  }
}
