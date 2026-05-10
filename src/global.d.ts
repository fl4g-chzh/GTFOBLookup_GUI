import type { LookupApi } from './shared/contracts'

declare global {
  interface Window {
    lookupApi: LookupApi
  }
}

export {}
