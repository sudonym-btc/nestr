export interface LandingLaunch {
  mode: 'landing'
}

export type LaunchView = 'relay' | 'group' | 'dm'

export interface MockLaunch {
  mode: 'mock'
  groupId?: string
  relayUrl: string
  authRequired: boolean
  initialView: LaunchView
}

export interface LiveLaunch {
  mode: 'live'
  groupId?: string
  relayUrl: string
  nostrConnectRelays: string[]
  initialView: LaunchView
}

export type LaunchConfig = LandingLaunch | MockLaunch | LiveLaunch

export const DEVELOPMENT_RELAYS = [
  {
    host: 'relay.nestr.development',
    label: 'Nestr development relay',
    description: 'Local persistent relay for testing private rooms and signed actions.',
    authRequired: true,
  },
  {
    host: 'openrelay.nestr.development',
    label: 'Nestr open relay',
    description: 'Local persistent relay for open rooms and low-friction demos.',
    authRequired: false,
  },
] as const

export function normalizeRelayUrl(value: string) {
  const withScheme = value.includes('://') ? value : `wss://${value}`
  const url = new URL(withScheme)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function relayHost(value: string) {
  try {
    return new URL(normalizeRelayUrl(value)).host
  } catch {
    return value
  }
}

export function isDevelopmentRelay(value: string) {
  const host = relayHost(value)
  return DEVELOPMENT_RELAYS.some((relay) => relay.host === host)
}

export function developmentRelayInfo(value: string) {
  const host = relayHost(value)
  return DEVELOPMENT_RELAYS.find((relay) => relay.host === host)
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
  const view = params.get('view') === 'dm' ? 'dm' : params.get('view') === 'relay' ? 'relay' : undefined
  const initialView = view ?? (groupId ? 'group' : 'relay')
  const nostrConnectRelays = relayListParams(params, [
    'connectRelay',
    'connect_relay',
    'connectRelays',
    'connect_relays',
    'nip46Relay',
    'nip46_relay',
  ]).map(normalizeRelayUrl)

  if (relay) {
    const developmentRelay = developmentRelayInfo(relay)
    if (developmentRelay) {
      return {
        mode: 'mock',
        groupId: groupId ?? undefined,
        relayUrl: normalizeRelayUrl(relay),
        authRequired: developmentRelay.authRequired,
        initialView,
      }
    }

    return {
      mode: 'live',
      groupId: groupId ?? undefined,
      relayUrl: normalizeRelayUrl(relay),
      nostrConnectRelays,
      initialView,
    }
  }

  return { mode: 'landing' }
}
