export interface MockLaunch {
  mode: 'mock'
}

export interface LiveLaunch {
  mode: 'live'
  groupId?: string
  relayUrl: string
  nostrConnectRelays: string[]
  initialView: 'relay' | 'group'
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

function relayListParams(params: URLSearchParams, names: string[]) {
  return names.flatMap((name) =>
    params
      .getAll(name)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

export function parseLaunch(search = globalThis.location?.search ?? ''): LaunchConfig {
  const params = new URLSearchParams(search)
  const groupId = params.get('c') ?? params.get('group') ?? params.get('h')
  const relay = params.get('relay')
  const nostrConnectRelays = relayListParams(params, [
    'connectRelay',
    'connect_relay',
    'connectRelays',
    'connect_relays',
    'nip46Relay',
    'nip46_relay',
  ]).map(normalizeRelayUrl)

  if (relay) {
    return {
      mode: 'live',
      groupId: groupId ?? undefined,
      relayUrl: normalizeRelayUrl(relay),
      nostrConnectRelays,
      initialView: groupId ? 'group' : 'relay',
    }
  }

  return { mode: 'mock' }
}
