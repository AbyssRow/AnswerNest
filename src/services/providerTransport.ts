import type { AIPlatform } from './modelConfig'
import type { ClientOptions } from '@tauri-apps/plugin-http'

export type ProviderConnection = Pick<AIPlatform, 'baseUrl' | 'apiKey' | 'customHeaders' | 'proxyUrl'>

export function validateProxyUrl(value?: string): string {
  if (!value?.trim()) return ''
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('代理地址必须是完整 URL') }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname) {
    throw new Error('代理仅支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H')
  }
  return url.toString()
}

// Preserve compatible-mode / gateway prefixes and query parameters; add v1 only at the root.
export function providerEndpoint(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS')
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/(?:chat\/completions|responses|messages(?:\/batches)?|models|batches|files|systemone)$/, '')
  if (!path) path = '/v1'
  url.pathname = path + '/' + resource.replace(/^\/+/, '')
  url.hash = ''
  return url.toString()
}

export function providerHeaders(platform: ProviderConnection, protocol?: string): Headers {
  const headers = new Headers()
  if (protocol === 'anthropic') {
    headers.set('anthropic-version', '2023-06-01')
    if (platform.apiKey) headers.set('x-api-key', platform.apiKey)
  } else if (platform.apiKey) headers.set('Authorization', `Bearer ${platform.apiKey}`)
  new Headers(platform.customHeaders).forEach((value, key) => headers.set(key, value))
  return headers
}

export function providerClientOptions(platform: Pick<AIPlatform, 'proxyUrl'>): ClientOptions {
  const proxyUrl = validateProxyUrl(platform.proxyUrl)
  return proxyUrl ? { proxy: { all: proxyUrl } } : {}
}

export function createProviderFetch(platform: ProviderConnection, signal?: AbortSignal): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const options = providerClientOptions(platform)
    const { fetch: nativeFetch } = await import('@tauri-apps/plugin-http')
    return nativeFetch(input, { ...init, ...options, credentials: init.credentials ?? 'include', signal: init.signal ?? signal })
  }
}
