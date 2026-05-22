export const DEFAULT_GROUP_ID = 'product-floor'
export const MOCK_RELAY_URL = 'wss://relay.nestr.local'

export const NIP29_KINDS = {
  groupMetadata: 39000,
  groupAdmins: 39001,
  groupMembers: 39002,
  groupRoles: 39003,
  putUser: 9000,
  removeUser: 9001,
  editMetadata: 9002,
  deleteEvent: 9005,
  createGroup: 9007,
  deleteGroup: 9008,
  createInvite: 9009,
  joinRequest: 9021,
  leaveRequest: 9022,
  chatMessage: 1,
} as const

export const OFFICE_KINDS = {
  avatarPosition: 25029,
  callOffer: 25050,
  callAnswer: 25051,
  iceCandidate: 25052,
  callHangup: 25053,
} as const

export type NostrTag = string[]

export interface NestrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: NostrTag[]
  content: string
  sig: string
}

export type NestrEventTemplate = Pick<NestrEvent, 'kind' | 'tags' | 'content' | 'created_at'>

export interface NestrSigner {
  pubkey: string
  label: string
  signEvent: (event: NestrEventTemplate) => Promise<NestrEvent>
  ping?: () => Promise<void>
  close?: () => void | Promise<void>
}

export function tagValue(event: Pick<NestrEvent, 'tags'>, name: string) {
  return event.tags.find((tag) => tag[0] === name)?.[1]
}

export function tagValues(event: Pick<NestrEvent, 'tags'>, name: string) {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1])
}

export function hasTag(event: Pick<NestrEvent, 'tags'>, name: string) {
  return event.tags.some((tag) => tag[0] === name)
}

export function groupTag(groupId = DEFAULT_GROUP_ID): NostrTag {
  return ['h', groupId]
}

export function dTag(groupId = DEFAULT_GROUP_ID): NostrTag {
  return ['d', groupId]
}

export function isEphemeralKind(kind: number) {
  return kind >= 20000 && kind < 30000
}

export function isNip29GroupEvent(event: Pick<NestrEvent, 'tags'>) {
  return hasTag(event, 'h')
}
