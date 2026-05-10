import {
  Agent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici'
import type { ProxySettings } from '../../src/shared/contracts'

const defaultDispatcher = getGlobalDispatcher()
let activeProxyDispatcher: Dispatcher | null = null

const normalizeProxySettings = (settings?: Partial<ProxySettings>): ProxySettings => ({
  enabled: Boolean(settings?.enabled),
  server: typeof settings?.server === 'string' ? settings.server.trim() : '',
})

export const configureRequestProxy = (settings?: Partial<ProxySettings>) => {
  const normalized = normalizeProxySettings(settings)

  if (activeProxyDispatcher) {
    activeProxyDispatcher.close().catch(() => undefined)
    activeProxyDispatcher = null
  }

  if (!normalized.enabled || !normalized.server) {
    setGlobalDispatcher(defaultDispatcher)
    return normalized
  }

  activeProxyDispatcher = new ProxyAgent(normalized.server)
  setGlobalDispatcher(activeProxyDispatcher)
  return normalized
}

export const resetRequestProxy = () => {
  if (activeProxyDispatcher) {
    activeProxyDispatcher.close().catch(() => undefined)
    activeProxyDispatcher = null
  }

  setGlobalDispatcher(defaultDispatcher ?? new Agent())
}

export const getProxySettingsFromEnv = (): ProxySettings => {
  const server =
    process.env.GTFOBLOOKUP_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy ??
    ''

  return {
    enabled: Boolean(server.trim()),
    server: server.trim(),
  }
}
