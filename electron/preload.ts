import { contextBridge, ipcRenderer } from 'electron'
import type { LookupApi, SearchQuery } from '../src/shared/contracts'

const api: LookupApi = {
  search: (query: SearchQuery) => ipcRenderer.invoke('lookup:search', query),
  getEntry: (id: string) => ipcRenderer.invoke('lookup:get-entry', id),
  getStats: () => ipcRenderer.invoke('lookup:get-stats'),
  syncAll: () => ipcRenderer.invoke('lookup:sync-all'),
  getAppSettings: () => ipcRenderer.invoke('lookup:get-app-settings'),
  saveAppSettings: (settings) => ipcRenderer.invoke('lookup:save-app-settings', settings),
  getProxySettings: () => ipcRenderer.invoke('lookup:get-proxy-settings'),
  saveProxySettings: (settings) => ipcRenderer.invoke('lookup:save-proxy-settings', settings),
}

contextBridge.exposeInMainWorld('lookupApi', api)
