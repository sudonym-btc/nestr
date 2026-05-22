export interface MockLaunch {
  mode: 'mock'
}

export interface LiveLaunch {
  mode: 'live'
  groupId: string
  relayUrl: string
}

export type LaunchConfig = MockLaunch | LiveLaunch

export function normalizeRelayUrl(value: string) {
  const withScheme = value.includes('://') ? value : `wss://${value}`
  const url = new URL(withScheme)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function parseLaunch(search = globalThis.location?.search ?? ''): LaunchConfig {
  const params = new URLSearchParams(search)
  const groupId = params.get('c') ?? params.get('group') ?? params.get('h')
  const relay = params.get('relay')

  if (groupId && relay) {
    return {
      mode: 'live',
      groupId,
      relayUrl: normalizeRelayUrl(relay),
    }
  }

  return { mode: 'mock' }
}
