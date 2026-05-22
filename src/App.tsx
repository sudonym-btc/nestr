import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as QRCode from 'qrcode'
import {
  Camera,
  CameraOff,
  ChevronLeft,
  Check,
  DoorOpen,
  Edit3,
  LockKeyhole,
  LoaderCircle,
  LogIn,
  LogOut,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  Radio,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Ticket,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react'
import './App.css'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OfficeRenderer } from './game/OfficeRenderer'
import { avatarCss, npubForPubkey, resolvePubkey, seededPubkey, shortNpub } from './lib/avatar'
import { parseLaunch } from './lib/launch'
import { createLiveRelay } from './lib/liveRelay'
import { createMockRelay, type MockUser, type RelaySnapshot } from './lib/mockRelay'
import { hasTag, tagValue, type NestrEvent, type NestrSigner } from './lib/nostr'
import {
  groupMetadataDraft,
  memberPubkeys,
  moderationSummary,
  supportedRoleTags,
  type Nip29MetadataDraft,
} from './lib/nip29'
import { createMockPeerVideo, type MockPeerVideo } from './lib/mockVideo'
import { parseNostrReferences, type EntityPart } from './lib/nostrReferences'
import { playMessageSound, primeMessageSound } from './lib/messageSound'
import { isOnlineFromActivity } from './lib/presence'
import {
  connectNip07Signer,
  restoreNostrConnectSigner,
  startNostrConnect,
  type NostrConnectSession,
} from './lib/signers'
import {
  clearStoredNostrConnectSession,
  readStoredNostrConnectSession,
  writeStoredNostrConnectSession,
} from './lib/secureSession'
import { estimateWebRtcMesh, meshHealth, nearbyPeers } from './lib/videoMesh'
import { buildOfficeMap, mapCapacityLabel, spawnForPubkey } from './lib/world'

function nameFor(pubkey: string, users: MockUser[]) {
  return users.find((user) => user.pubkey === pubkey)?.name ?? shortNpub(pubkey)
}

function groupTagLabel(snapshot: RelaySnapshot) {
  const tags = ['private', 'public', 'restricted', 'closed', 'hidden'].filter((tag) =>
    hasTag(snapshot.group.metadata, tag),
  )
  return tags.length > 0 ? tags.join(' ') : 'open group'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function rolesForPubkey(snapshot: RelaySnapshot, pubkey: string) {
  return snapshot.group.admins.tags
    .filter((tag) => tag[0] === 'p' && tag[1] === pubkey)
    .flatMap((tag) => tag.slice(2).filter(Boolean))
}

function roleList(value: string) {
  return value
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean)
}

function randomInviteCode() {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function relayHostLabel(relayUrl: string) {
  try {
    return new URL(relayUrl).host
  } catch {
    return relayUrl
  }
}

function relayGroupSearchText(groupEvent: NestrEvent, fallbackGroupId: string) {
  const groupId = tagValue(groupEvent, 'd') ?? fallbackGroupId
  const name = tagValue(groupEvent, 'name') ?? ''
  const about = tagValue(groupEvent, 'about') ?? ''
  return `${groupId} ${name} ${about}`.toLowerCase()
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

interface AvatarChipProps {
  pubkey: string
  user?: MockUser
  small?: boolean
}

function AvatarChip({ pubkey, user, small = false }: AvatarChipProps) {
  const candidates = user?.pictureCandidates?.length ? user.pictureCandidates : user?.pictureUrl ? [user.pictureUrl] : []
  const candidatesKey = candidates.join('|')
  const [failed, setFailed] = useState({ key: '', index: 0 })
  const candidateIndex = failed.key === candidatesKey ? failed.index : 0
  const src = candidateIndex < candidates.length ? candidates[candidateIndex] : undefined

  return (
    <Avatar
      className={`avatar-chip ${small ? 'small' : ''} ${src ? 'has-image' : ''}`}
      size={small ? 'sm' : 'default'}
      style={avatarCss(pubkey)}
    >
      {src && (
        <AvatarImage
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          onLoadingStatusChange={(status) => {
            if (status === 'error') setFailed({ key: candidatesKey, index: candidateIndex + 1 })
          }}
        />
      )}
      <AvatarFallback />
    </Avatar>
  )
}

interface NostrEntityChipProps {
  entity: EntityPart
  users: MockUser[]
}

function entityLabel(entity: EntityPart, users: MockUser[]) {
  if (entity.entityType === 'profile' && entity.pubkey) {
    const user = users.find((candidate) => candidate.pubkey === entity.pubkey)
    return user?.name ?? shortNpub(entity.pubkey)
  }

  if (entity.entityType === 'address') {
    return entity.kind ? `address:${entity.kind}` : 'address'
  }

  return entity.kind ? `event:${entity.kind}` : 'event'
}

function NostrEntityChip({ entity, users }: NostrEntityChipProps) {
  const user = entity.pubkey ? users.find((candidate) => candidate.pubkey === entity.pubkey) : undefined

  return (
    <a
      className={`nostr-chip ${entity.entityType}`}
      href={entity.href}
      target="_blank"
      rel="noreferrer"
      title={entity.code}
    >
      {entity.entityType === 'profile' && entity.pubkey && (
        <AvatarChip pubkey={entity.pubkey} user={user} small />
      )}
      <span>{entityLabel(entity, users)}</span>
    </a>
  )
}

interface MessageContentProps {
  event: NestrEvent
  users: MockUser[]
}

function MessageContent({ event, users }: MessageContentProps) {
  const parts = parseNostrReferences(event.content, event.tags)

  return (
    <p>
      {parts.map((part, index) =>
        part.type === 'text' ? (
          <span key={`${index}-text`}>{part.text}</span>
        ) : (
          <NostrEntityChip key={`${index}-${part.code}`} entity={part} users={users} />
        ),
      )}
    </p>
  )
}

interface StreamTileProps {
  label: string
  sublabel: string
  stream: MediaStream | null
  muted?: boolean
  micMuted?: boolean
  status?: 'local' | 'remote' | 'screen'
}

type AuthState = 'mock' | 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'disconnected'
type AppView = 'relay' | 'group' | 'dm'
type AuthPromptKind = 'relay' | 'dm' | 'write' | 'admin' | 'reconnect' | 'manual'

interface AuthPrompt {
  kind: AuthPromptKind
  title: string
  detail: string
}

function signerRequired(reason?: string) {
  const value = String(reason ?? '').toLowerCase()
  return (
    value === 'live-signer-required' ||
    value.includes('auth-required') ||
    value.includes('signer required') ||
    value.includes('nip-42') ||
    value.includes('restricted')
  )
}

function authPromptTitle(kind: AuthPromptKind) {
  if (kind === 'dm') return 'Unlock direct messages'
  if (kind === 'relay') return 'Relay needs auth'
  if (kind === 'write') return 'Sign to write'
  if (kind === 'admin') return 'Sign admin action'
  if (kind === 'reconnect') return 'Signer disconnected'
  return 'Sign in with Nostr'
}

function StreamTile({ label, sublabel, stream, muted = false, micMuted = false, status = 'remote' }: StreamTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  return (
    <Card className={`stream-tile ${stream ? '' : 'empty'} ${status}`} size="sm">
      {stream ? <video ref={videoRef} autoPlay muted={muted} playsInline /> : <div className="stream-empty" />}
      <div className="stream-label">
        <strong>{label}</strong>
        <span>{sublabel}</span>
      </div>
      <span className={`stream-mic ${micMuted ? 'muted' : ''}`} aria-label={micMuted ? `${label} muted` : `${label} unmuted`}>
        {micMuted ? <MicOff size={14} /> : <Mic size={14} />}
      </span>
    </Card>
  )
}

function App() {
  const launch = useMemo(() => parseLaunch(), [])
  const relay = useMemo(
    () => (launch.mode === 'live' ? createLiveRelay(launch.groupId, launch.relayUrl) : createMockRelay()),
    [launch],
  )
  const [snapshot, setSnapshot] = useState(() => relay.snapshot())
  const [selfPubkey, setSelfPubkey] = useState(() => snapshot.users[0]?.pubkey ?? seededPubkey('live-viewer'))
  const [npubInput, setNpubInput] = useState<string>(() => npubForPubkey(snapshot.users[0]?.pubkey ?? selfPubkey))
  const [message, setMessage] = useState('')
  const [relaySearch, setRelaySearch] = useState('')
  const [appView, setAppView] = useState<AppView>(() =>
    launch.mode === 'live' ? launch.initialView : 'group',
  )
  const [activeDmPubkey, setActiveDmPubkey] = useState<string | null>(null)
  const [dmMessage, setDmMessage] = useState('')
  const [callStarted, setCallStarted] = useState(false)
  const [mediaState, setMediaState] = useState<'idle' | 'requesting' | 'live' | 'blocked'>('idle')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [remoteVideos, setRemoteVideos] = useState<MockPeerVideo[]>([])
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [micEnabled, setMicEnabled] = useState(true)
  const [callExpanded, setCallExpanded] = useState(false)
  const [authState, setAuthState] = useState<AuthState>(() => (launch.mode === 'live' ? 'idle' : 'mock'))
  const [authStatus, setAuthStatus] = useState(() =>
    launch.mode === 'live' ? 'opening live chatroom' : 'local mock relay',
  )
  const [authDetail, setAuthDetail] = useState(() =>
    launch.mode === 'live' ? 'waiting for signer' : 'local mock relay',
  )
  const [activeSigner, setActiveSigner] = useState<NestrSigner | null>(null)
  const [adminStatus, setAdminStatus] = useState('Chatroom controls ready')
  const [joinReason, setJoinReason] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [targetInput, setTargetInput] = useState('')
  const [targetRoles, setTargetRoles] = useState('')
  const [eventIdInput, setEventIdInput] = useState('')
  const [inviteCode, setInviteCode] = useState(() => randomInviteCode())
  const [metadataEdits, setMetadataEdits] = useState<Partial<Nip29MetadataDraft>>({})
  const [connectSession, setConnectSession] = useState<NostrConnectSession | null>(null)
  const [nostrConnectQr, setNostrConnectQr] = useState<string | null>(null)
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null)
  const callStageRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const dmMessagesEndRef = useRef<HTMLDivElement | null>(null)
  const notifiedRef = useRef({ initialized: false, chat: new Set<string>(), dm: new Set<string>() })
  const autoAuthAttemptedRef = useRef(false)
  const authAttemptRef = useRef(0)
  const lastRelayAuthPromptRef = useRef('')
  const activeSignerRef = useRef<NestrSigner | null>(null)
  const connectSessionRef = useRef<NostrConnectSession | null>(null)
  const remoteVideosRef = useRef<MockPeerVideo[]>([])

  const activeCount = Math.max(snapshot.positions.length, snapshot.users.length)
  const officeMap = useMemo(
    () => buildOfficeMap(snapshot.group.id, activeCount),
    [snapshot.group.id, activeCount],
  )
  const nearby = nearbyPeers(selfPubkey, snapshot.positions, 136)
  const mesh = estimateWebRtcMesh(nearby.length + 1)
  const health = meshHealth(mesh.participants)
  const metadataName = tagValue(snapshot.group.metadata, 'name') ?? 'Chatroom'
  const groupAbout = tagValue(snapshot.group.metadata, 'about') ?? ''
  const relayHost = relayHostLabel(snapshot.group.relay)
  const hasSelectedGroup = relay.mode === 'mock' || (launch.mode === 'live' && Boolean(launch.groupId))
  const relayGroups = useMemo(
    () => (snapshot.relayGroups.length > 0 || !hasSelectedGroup ? snapshot.relayGroups : [snapshot.group.metadata]),
    [hasSelectedGroup, snapshot.group.metadata, snapshot.relayGroups],
  )
  const normalizedRelaySearch = relaySearch.trim().toLowerCase()
  const filteredRelayGroups = useMemo(
    () =>
      normalizedRelaySearch
        ? relayGroups.filter((groupEvent) =>
            relayGroupSearchText(groupEvent, snapshot.group.id).includes(normalizedRelaySearch),
          )
        : relayGroups,
    [normalizedRelaySearch, relayGroups, snapshot.group.id],
  )
  const relayGroupCountLabel =
    filteredRelayGroups.length === relayGroups.length
      ? String(relayGroups.length)
      : `${filteredRelayGroups.length} / ${relayGroups.length}`
  const connectionStatus = snapshot.connectionStatus ?? relay.mode
  const connectionMessage = authDetail || snapshot.connectionMessage || authStatus
  const showAuthPrompt = relay.mode === 'live' && Boolean(authPrompt) && authState !== 'connected'
  const showSignerPill =
    relay.mode === 'live' && ['connected', 'reconnecting', 'disconnected'].includes(authState)
  const currentUser = snapshot.users.find((user) => user.pubkey === selfPubkey)
  const isSignedIn = relay.mode === 'mock' || authState === 'connected'
  const showMesh = isSignedIn && nearby.length > 0
  const groupMemberPubkeys = useMemo(() => memberPubkeys(snapshot.group.members), [snapshot.group.members])
  const groupMemberSet = useMemo(() => new Set(groupMemberPubkeys), [groupMemberPubkeys])
  const currentRoles = rolesForPubkey(snapshot, selfPubkey)
  const currentIsMember = groupMemberSet.has(selfPubkey)
  const canManageGroup = currentRoles.length > 0 || currentUser?.role === 'admin' || currentUser?.role === 'moderator'
  const supportedRoles = supportedRoleTags(snapshot.group.roles)
  const visiblePeople = snapshot.users.filter((user) => groupMemberSet.has(user.pubkey) || user.pubkey === selfPubkey)
  const isOnline = useCallback(
    (pubkey: string) => isOnlineFromActivity(pubkey, snapshot.presence, snapshot.positions),
    [snapshot.positions, snapshot.presence],
  )
  const dmThreads = useMemo(() => {
    const byPeer = new Map<string, { pubkey: string; lastAt: number; preview: string }>()

    snapshot.directMessages.forEach((dm) => {
      if (dm.senderPubkey !== selfPubkey && dm.recipientPubkey !== selfPubkey) return
      const peer = dm.senderPubkey === selfPubkey ? dm.recipientPubkey : dm.senderPubkey
      const current = byPeer.get(peer)
      if (!current || dm.createdAt >= current.lastAt) {
        byPeer.set(peer, {
          pubkey: peer,
          lastAt: dm.createdAt,
          preview: `${dm.senderPubkey === selfPubkey ? 'You: ' : ''}${dm.content}`,
        })
      }
    })

    return Array.from(byPeer.values()).sort((a, b) => {
      if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt
      return nameFor(a.pubkey, snapshot.users).localeCompare(nameFor(b.pubkey, snapshot.users))
    })
  }, [selfPubkey, snapshot.directMessages, snapshot.users])
  const activeDmMessages = useMemo(
    () =>
      activeDmPubkey
        ? snapshot.directMessages.filter(
            (dm) =>
              (dm.senderPubkey === selfPubkey && dm.recipientPubkey === activeDmPubkey) ||
              (dm.senderPubkey === activeDmPubkey && dm.recipientPubkey === selfPubkey),
          )
        : [],
    [activeDmPubkey, selfPubkey, snapshot.directMessages],
  )
  const activeDmPeer = activeDmPubkey ? snapshot.users.find((user) => user.pubkey === activeDmPubkey) : undefined
  const metadataBaseDraft = useMemo(
    () => groupMetadataDraft(snapshot.group.metadata),
    [snapshot.group.metadata],
  )
  const metadataDraft = useMemo(
    () => ({ ...metadataBaseDraft, ...metadataEdits }),
    [metadataBaseDraft, metadataEdits],
  )
  const callPeers = useMemo(() => {
    const nearbyPubkeys = nearby.map((peer) => peer.pubkey)
    const fallbackPubkeys = snapshot.users
      .filter((user) => user.pubkey !== selfPubkey)
      .slice(0, 4)
      .map((user) => user.pubkey)
    const pubkeys = (nearbyPubkeys.length > 0 ? nearbyPubkeys : fallbackPubkeys).slice(0, 5)

    return pubkeys.map((pubkey) => ({
      pubkey,
      name: nameFor(pubkey, snapshot.users),
    }))
  }, [nearby, selfPubkey, snapshot.users])
  const callPeerKey = callPeers.map((peer) => `${peer.pubkey}:${peer.name}`).join('|')
  const displayedMesh = estimateWebRtcMesh((callStarted ? callPeers.length : nearby.length) + 1)
  const frozenPeerPubkeys = remoteVideos.map((video) => video.pubkey).join('|')
  const canScreenShare = Boolean(navigator.mediaDevices?.getDisplayMedia)

  useEffect(() => {
    const unsubscribe = relay.subscribe((next) => setSnapshot(next))
    return () => {
      unsubscribe()
      if (relay.mode === 'live') relay.close()
    }
  }, [relay])

  useEffect(() => {
    if (relay.mode !== 'mock') return undefined

    const timer = window.setInterval(() => {
      relay.tickBots(selfPubkey, officeMap, frozenPeerPubkeys.split('|').filter(Boolean))
    }, 560)

    return () => window.clearInterval(timer)
  }, [frozenPeerPubkeys, officeMap, relay, selfPubkey])

  useEffect(() => {
    return () => {
      localStream?.getTracks().forEach((track) => track.stop())
    }
  }, [localStream])

  useEffect(() => {
    return () => {
      screenStream?.getTracks().forEach((track) => track.stop())
    }
  }, [screenStream])

  useEffect(() => {
    return () => remoteVideosRef.current.forEach((video) => video.stop())
  }, [])

  useEffect(() => {
    if (!callStarted) return undefined

    const timer = window.setTimeout(() => {
      replaceRemoteVideos(reconcileMockVideos(callPeerKey))
    }, 0)

    return () => window.clearTimeout(timer)
  }, [callPeerKey, callStarted])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setCallExpanded(document.fullscreenElement === callStageRef.current)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [snapshot.messages.length, snapshot.group.id])

  useEffect(() => {
    dmMessagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeDmPubkey, activeDmMessages.length])

  useEffect(() => {
    const prime = () => {
      void primeMessageSound()
    }
    window.addEventListener('pointerdown', prime)
    window.addEventListener('keydown', prime)
    return () => {
      window.removeEventListener('pointerdown', prime)
      window.removeEventListener('keydown', prime)
    }
  }, [])

  useEffect(() => {
    const notified = notifiedRef.current
    if (!notified.initialized) {
      snapshot.messages.forEach((event) => notified.chat.add(event.id))
      snapshot.directMessages.forEach((dm) => notified.dm.add(dm.id))
      notified.initialized = true
      return
    }

    let shouldPlay = false
    const isChatMember = relay.mode === 'mock' || currentIsMember
    snapshot.messages.forEach((event) => {
      if (notified.chat.has(event.id)) return
      notified.chat.add(event.id)
      if (isChatMember && event.pubkey !== selfPubkey) shouldPlay = true
    })
    snapshot.directMessages.forEach((dm) => {
      if (notified.dm.has(dm.id)) return
      notified.dm.add(dm.id)
      if (dm.senderPubkey !== selfPubkey && dm.recipientPubkey === selfPubkey) shouldPlay = true
    })

    if (shouldPlay) playMessageSound()
  }, [currentIsMember, relay.mode, selfPubkey, snapshot.directMessages, snapshot.messages])

  const clearConnectSession = useCallback(() => {
    connectSessionRef.current?.abort()
    connectSessionRef.current = null
    setConnectSession(null)
    setNostrConnectQr(null)
  }, [])

  const applySigner = useCallback(
    async (signer: NestrSigner) => {
      if (relay.mode !== 'live') return

      const spawn = spawnForPubkey(officeMap, signer.pubkey, snapshot.users.length)
      await relay.setSigner(signer)
      activeSignerRef.current = signer
      setActiveSigner(signer)
      setAuthState('connected')
      setSelfPubkey(signer.pubkey)
      setNpubInput(npubForPubkey(signer.pubkey))
      setCallStarted(false)
      stopRemoteVideos()
      setCallExpanded(false)
      setAuthStatus(`${signer.label} connected as ${shortNpub(signer.pubkey)}`)
      setAuthDetail('signer online')
      setAuthPrompt(null)
      clearConnectSession()

      const result = await relay.publishPosition(signer.pubkey, spawn.x, spawn.y, 0, 0)
      if (!result.ok && result.reason !== 'throttled' && result.reason !== 'group-required') {
        setAuthDetail(`position publish failed: ${result.reason}`)
      }
    },
    [clearConnectSession, officeMap, relay, snapshot.users.length],
  )

  const markSignerDisconnected = useCallback(
    (detail: string) => {
      activeSignerRef.current = null
      setActiveSigner(null)
      setAuthState('disconnected')
      setAuthStatus('signer disconnected')
      setAuthDetail(detail)
      setAuthPrompt({
        kind: 'reconnect',
        title: authPromptTitle('reconnect'),
        detail,
      })
      if (relay.mode === 'live') relay.clearSigner()
    },
    [relay],
  )

  const completeAuthAttempt = useCallback(
    async (attempt: number, signer: NestrSigner, storedSession?: Awaited<ReturnType<typeof readStoredNostrConnectSession>>) => {
      if (attempt !== authAttemptRef.current) {
        await signer.close?.()
        return
      }
      if (activeSignerRef.current) {
        await signer.close?.()
        return
      }

      if (storedSession) await writeStoredNostrConnectSession(storedSession)
      await applySigner(signer)
    },
    [applySigner],
  )

  const beginLogin = useCallback(async (prompt?: AuthPrompt) => {
    if (relay.mode !== 'live') return

    const attempt = authAttemptRef.current + 1
    authAttemptRef.current = attempt
    activeSignerRef.current = null
    setActiveSigner(null)
    setAuthPrompt(
      prompt ?? {
        kind: 'manual',
        title: authPromptTitle('manual'),
        detail: 'Choose your browser signer or scan Nostr Connect to continue.',
      },
    )
    setAuthState('connecting')
    setAuthStatus(window.nostr ? 'asking browser signer' : 'waiting for Nostr Connect')
    setAuthDetail(window.nostr ? 'signer prompt open; QR also ready' : 'scan the QR with your signer')
    clearConnectSession()

    const session = startNostrConnect({
      roomRelayUrl: relay.relayUrl,
      nostrConnectRelays: launch.mode === 'live' ? launch.nostrConnectRelays : undefined,
    })
    connectSessionRef.current = session
    setConnectSession(session)
    setNostrConnectQr(null)
    setAuthDetail(`opening listener on ${session.relays.map(relayHostLabel).join(', ')}`)

    session.ready
      .then(async () => {
        if (attempt !== authAttemptRef.current || activeSignerRef.current) return
        setAuthDetail(`scan QR; listening on ${session.relays.map(relayHostLabel).join(', ')}`)
        try {
          const dataUrl = await QRCode.toDataURL(session.uri, {
            margin: 1,
            width: 180,
            color: {
              dark: '#171922',
              light: '#fffdf8',
            },
          })
          if (attempt === authAttemptRef.current) setNostrConnectQr(dataUrl)
        } catch {
          if (attempt === authAttemptRef.current) setNostrConnectQr(null)
        }
      })
      .catch((error) => {
        if (attempt !== authAttemptRef.current || activeSignerRef.current) return
        setAuthStatus('Nostr Connect listener failed')
        setAuthDetail(errorMessage(error))
      })

    session.waitForSigner
      .then((result) => completeAuthAttempt(attempt, result.signer, result.storedSession))
      .catch((error) => {
        if (attempt !== authAttemptRef.current || activeSignerRef.current) return
        setAuthDetail(`Nostr Connect unavailable: ${errorMessage(error)}`)
      })

    const waitForNip07 = async () => {
      const startedAt = Date.now()
      while (!window.nostr && Date.now() - startedAt < 4_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 120))
      }
      return Boolean(window.nostr)
    }

    waitForNip07().then((available) => {
      if (!available || attempt !== authAttemptRef.current || activeSignerRef.current) return
      setAuthStatus('asking browser signer')
      setAuthDetail(`signer prompt open; QR also listening on ${session.relays.map(relayHostLabel).join(', ')}`)
      connectNip07Signer()
        .then((signer) => completeAuthAttempt(attempt, signer))
        .catch((error) => {
          if (attempt !== authAttemptRef.current || activeSignerRef.current) return
          setAuthStatus('waiting for Nostr Connect')
          setAuthDetail(`browser signer unavailable: ${errorMessage(error)}`)
        })
    })
  }, [clearConnectSession, completeAuthAttempt, launch, relay])

  const beginAutoAuth = useCallback(async (interactiveFallback = false) => {
    if (relay.mode !== 'live') return

    const attempt = authAttemptRef.current + 1
    authAttemptRef.current = attempt
    clearConnectSession()
    const storedSession = await readStoredNostrConnectSession()

    if (attempt !== authAttemptRef.current) return

    if (storedSession) {
      setAuthState('reconnecting')
      setAuthStatus('reconnecting signer')
      setAuthDetail(`restoring ${shortNpub(storedSession.userPubkey)}`)
      try {
        const signer = await withTimeout(
          restoreNostrConnectSigner(storedSession),
          9_000,
          'signer reconnect timed out',
        )
        await completeAuthAttempt(attempt, signer, storedSession)
        return
      } catch (error) {
        if (attempt !== authAttemptRef.current) return
        markSignerDisconnected(`could not reconnect: ${errorMessage(error)}`)
        return
      }
    }

    if (interactiveFallback) {
      await beginLogin({
        kind: 'manual',
        title: authPromptTitle('manual'),
        detail: 'No stored signer session was found. Connect a signer to continue.',
      })
      return
    }

    setAuthState('idle')
    setAuthStatus('signer ready when needed')
    setAuthDetail('waiting for an auth-gated action')
  }, [beginLogin, clearConnectSession, completeAuthAttempt, markSignerDisconnected, relay])

  useEffect(() => {
    activeSignerRef.current = activeSigner
  }, [activeSigner])

  useEffect(() => {
    return () => {
      connectSessionRef.current?.abort()
      void activeSignerRef.current?.close?.()
    }
  }, [])

  useEffect(() => {
    if (relay.mode !== 'live' || authState !== 'connected' || !activeSigner?.ping) return undefined

    const pingSigner = async () => {
      try {
        await withTimeout(activeSigner.ping?.() ?? Promise.resolve(), 8_000, 'signer ping timed out')
      } catch (error) {
        markSignerDisconnected(errorMessage(error))
      }
    }

    const timer = window.setInterval(() => {
      void pingSigner()
    }, 20_000)

    return () => window.clearInterval(timer)
  }, [activeSigner, authState, markSignerDisconnected, relay.mode])

  useEffect(() => {
    if (relay.mode !== 'live' || autoAuthAttemptedRef.current) return

    const timer = window.setTimeout(() => {
      if (autoAuthAttemptedRef.current) return

      autoAuthAttemptedRef.current = true
      void beginAutoAuth()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [beginAutoAuth, relay])

  useEffect(() => {
    if (relay.mode !== 'live') return
    if (authState === 'connected' || authState === 'connecting' || authState === 'reconnecting') return
    const key = `${snapshot.connectionStatus ?? ''}:${snapshot.connectionMessage ?? ''}`
    if (key === lastRelayAuthPromptRef.current || !signerRequired(snapshot.connectionMessage)) return

    lastRelayAuthPromptRef.current = key
    const timer = window.setTimeout(() => {
      void beginLogin({
        kind: 'relay',
        title: authPromptTitle('relay'),
        detail: `${relayHost} wants relay auth before returning this chatroom. The room query will retry after signing in.`,
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [authState, beginLogin, relay.mode, relayHost, snapshot.connectionMessage, snapshot.connectionStatus])

  useEffect(() => {
    if (relay.mode !== 'live' || appView !== 'dm') return
    if (authState === 'connected' || authState === 'connecting' || authState === 'reconnecting') return
    const timer = window.setTimeout(() => {
      void beginLogin({
        kind: 'dm',
        title: authPromptTitle('dm'),
        detail: `Direct messages need your signer so ${relayHost} can return your threads.`,
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [appView, authState, beginLogin, relay.mode, relayHost])

  async function retrySigner() {
    if (relay.mode !== 'live') return
    setAuthDetail('retrying signer connection')
    setAuthPrompt({
      kind: 'reconnect',
      title: authPromptTitle('reconnect'),
      detail: 'Retrying the stored signer session. If it stays offline, log out and connect again.',
    })
    await beginAutoAuth(true)
  }

  async function logoutSigner() {
    authAttemptRef.current += 1
    clearConnectSession()
    await activeSignerRef.current?.close?.()
    activeSignerRef.current = null
    setActiveSigner(null)
    if (relay.mode === 'live') relay.clearSigner()
    await clearStoredNostrConnectSession()
    setSelfPubkey(seededPubkey('live-viewer'))
    setCallStarted(false)
    stopScreenShare()
    stopRemoteVideos()
    setCallExpanded(false)
    setAuthState('idle')
    setAuthStatus('logged out')
    setAuthDetail('waiting for an auth-gated action')
    setAuthPrompt(null)
  }

  function cancelAuthPrompt() {
    authAttemptRef.current += 1
    clearConnectSession()
    if (authState === 'connecting') {
      setAuthState('idle')
      setAuthStatus('signer ready when needed')
      setAuthDetail('waiting for an auth-gated action')
    }
    setAuthPrompt(null)
  }

  const requestAuth = useCallback(
    (kind: AuthPromptKind, detail: string) => {
      if (relay.mode !== 'live' || authState === 'connected') return
      void beginLogin({
        kind,
        title: authPromptTitle(kind),
        detail,
      })
    },
    [authState, beginLogin, relay.mode],
  )

  const handleMove = useCallback(
    (position: { x: number; y: number; vx: number; vy: number }) => {
      relay.publishPosition(selfPubkey, position.x, position.y, position.vx, position.vy)
    },
    [relay, selfPubkey],
  )

  function joinOffice(event: FormEvent) {
    event.preventDefault()
    const user = relay.joinWithNpub(npubInput)
    setSelfPubkey(user.pubkey)
    setNpubInput(user.npub)
    setCallStarted(false)
    stopScreenShare()
    stopRemoteVideos()
    setCallExpanded(false)
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const result = await relay.publishGroupMessage(selfPubkey, message)
    if (!result.ok) {
      if (signerRequired(result.reason)) {
        requestAuth('write', `Sign in to publish messages to ${metadataName}. The message can be sent after auth completes.`)
      } else {
        setAuthStatus(String(result.reason))
      }
      return
    }
    setMessage('')
  }

  async function sendDirectMessage(event: FormEvent) {
    event.preventDefault()
    if (!activeDmPubkey) return

    const result = await relay.publishDirectMessage(selfPubkey, activeDmPubkey, dmMessage)
    if (!result.ok) {
      if (signerRequired(result.reason)) {
        requestAuth('dm', 'Sign in to send encrypted direct messages.')
      } else {
        setAuthStatus(String(result.reason))
      }
      return
    }

    setDmMessage('')
  }

  function selectRelayGroup(groupId: string) {
    if (hasSelectedGroup && groupId === snapshot.group.id) {
      setAppView('group')
      return
    }

    const url = new URL(window.location.href)
    url.searchParams.set('c', groupId)
    url.searchParams.set('relay', relayHostLabel(snapshot.group.relay))
    window.location.href = url.toString()
  }

  async function runNip29Action(label: string, action: () => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }) {
    setAdminStatus(`${label}...`)
    try {
      const result = await action()
      setAdminStatus(result.ok ? `${label} published` : `${label} failed: ${result.reason}`)
      if (!result.ok && signerRequired(result.reason)) {
        requestAuth('admin', `Sign in to publish the ${label} chatroom admin action.`)
      }
      return result.ok
    } catch (error) {
      setAdminStatus(`${label} failed: ${errorMessage(error)}`)
      return false
    }
  }

  function targetPubkeyFromInput() {
    try {
      return resolvePubkey(targetInput)
    } catch (error) {
      setAdminStatus(errorMessage(error))
      return null
    }
  }

  async function requestJoin(event: FormEvent) {
    event.preventDefault()
    await runNip29Action('join request', () => relay.publishJoinRequest(selfPubkey, joinReason, joinCode))
  }

  async function leaveGroup() {
    const ok = await runNip29Action('leave request', () =>
      relay.publishLeaveRequest(selfPubkey, 'leaving from nestr'),
    )
    if (ok) {
      setCallStarted(false)
      stopScreenShare()
      stopRemoteVideos()
      setCallExpanded(false)
    }
  }

  async function putUser(event: FormEvent) {
    event.preventDefault()
    const target = targetPubkeyFromInput()
    if (!target) return

    await runNip29Action('put-user', () =>
      relay.publishPutUser(selfPubkey, target, roleList(targetRoles), 'updated from nestr'),
    )
  }

  async function removeUser() {
    const target = targetPubkeyFromInput()
    if (!target) return

    await runNip29Action('remove-user', () => relay.publishRemoveUser(selfPubkey, target, 'removed from nestr'))
  }

  async function acceptJoin(pubkey: string) {
    await runNip29Action('accept join', () => relay.publishPutUser(selfPubkey, pubkey, [], 'join accepted'))
  }

  async function rejectJoin(pubkey: string) {
    await runNip29Action('reject join', () => relay.publishRemoveUser(selfPubkey, pubkey, 'join rejected'))
  }

  async function editMetadata(event: FormEvent) {
    event.preventDefault()
    const ok = await runNip29Action('details', () =>
      relay.publishEditMetadata(selfPubkey, metadataDraft, 'metadata updated from nestr'),
    )
    if (ok) setMetadataEdits({})
  }

  async function deleteEvent(eventId = eventIdInput) {
    const trimmed = eventId.trim()
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
      setAdminStatus('Enter a 64-character event id')
      return
    }

    const ok = await runNip29Action('delete-event', () =>
      relay.publishDeleteEvent(selfPubkey, trimmed, 'deleted from nestr'),
    )
    if (ok) setEventIdInput('')
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault()
    const ok = await runNip29Action('create-invite', () =>
      relay.publishCreateInvite(selfPubkey, inviteCode, 'invite created from nestr'),
    )
    if (ok) setInviteCode(randomInviteCode())
  }

  async function createGroup() {
    await runNip29Action('create-group', () => relay.publishCreateGroup(selfPubkey, 'group created from nestr'))
  }

  async function deleteGroup() {
    await runNip29Action('delete-group', () => relay.publishDeleteGroup(selfPubkey, 'group deleted from nestr'))
  }

  function reconcileMockVideos(peerKey: string) {
    const peers = peerKey
      .split('|')
      .filter(Boolean)
      .map((peer) => {
        const [pubkey, name] = peer.split(':')
        return { pubkey, name }
      })
    const previous = new Map(remoteVideosRef.current.map((video) => [video.pubkey, video]))
    const wanted = new Set(peers.map((peer) => peer.pubkey))
    const next = peers.map((peer) => previous.get(peer.pubkey) ?? createMockPeerVideo(peer.pubkey, peer.name))

    remoteVideosRef.current
      .filter((video) => !wanted.has(video.pubkey))
      .forEach((video) => video.stop())

    return next
  }

  function replaceRemoteVideos(videos: MockPeerVideo[]) {
    remoteVideosRef.current = videos
    setRemoteVideos(videos)
  }

  function stopRemoteVideos() {
    remoteVideosRef.current.forEach((video) => video.stop())
    remoteVideosRef.current = []
    setRemoteVideos([])
  }

  function stopScreenShare() {
    screenStream?.getTracks().forEach((track) => track.stop())
    setScreenStream(null)
  }

  async function requestLocalMedia(nextCamera = cameraEnabled, nextMic = micEnabled) {
    localStream?.getTracks().forEach((track) => track.stop())
    setLocalStream(null)

    if (!nextCamera && !nextMic) {
      setMediaState('idle')
      return
    }

    setMediaState('requesting')

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('media devices unavailable')
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: nextMic,
          video: nextCamera
            ? {
                width: { ideal: 640 },
                height: { ideal: 360 },
              }
            : false,
        }),
        8000,
        'camera request timed out',
      )
      stream.getAudioTracks().forEach((track) => {
        track.enabled = nextMic
      })
      stream.getVideoTracks().forEach((track) => {
        track.enabled = nextCamera
      })
      setLocalStream(stream)
      setMediaState('live')
    } catch {
      setMediaState('blocked')
    }
  }

  async function toggleCall() {
    if (callStarted) {
      localStream?.getTracks().forEach((track) => track.stop())
      stopScreenShare()
      stopRemoteVideos()
      setLocalStream(null)
      setCallStarted(false)
      setCallExpanded(false)
      setMediaState('idle')
      return
    }

    setMediaState('requesting')
    setCameraEnabled(true)
    setMicEnabled(true)
    replaceRemoteVideos(reconcileMockVideos(callPeerKey))
    setCallStarted(true)
    await requestLocalMedia(true, true)
  }

  async function toggleCamera() {
    const nextCamera = !cameraEnabled
    setCameraEnabled(nextCamera)
    if (localStream?.getVideoTracks().length) {
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = nextCamera
      })
      if (!nextCamera) return
    }
    await requestLocalMedia(nextCamera, micEnabled)
  }

  async function toggleMic() {
    const nextMic = !micEnabled
    setMicEnabled(nextMic)
    if (localStream?.getAudioTracks().length) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = nextMic
      })
      return
    }
    await requestLocalMedia(cameraEnabled, nextMic)
  }

  async function toggleScreenShare() {
    if (screenStream) {
      stopScreenShare()
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia) return

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      stream.getVideoTracks()[0]?.addEventListener('ended', () => setScreenStream(null), { once: true })
      setScreenStream(stream)
    } catch {
      setScreenStream(null)
    }
  }

  async function toggleCallFullscreen() {
    const element = callStageRef.current
    if (!element) return

    if (document.fullscreenElement) {
      await document.exitFullscreen()
      setCallExpanded(false)
      return
    }

    setCallExpanded(true)
    try {
      await element.requestFullscreen()
    } catch {
      setCallExpanded(true)
    }
  }

  return (
    <TooltipProvider>
    <main className="app-shell" data-auth-state={authState} data-view={appView}>
      {showSignerPill && (
        <section className={`signer-pill ${authState}`} aria-label="Signer status">
          <AvatarChip pubkey={selfPubkey} user={currentUser} small />
          <div>
            <strong>
              {authState === 'connected'
                ? `signed in ${shortNpub(selfPubkey)}`
                : authState === 'reconnecting'
                  ? 'reconnecting signer'
                  : 'signer disconnected'}
            </strong>
            <span>{authDetail}</span>
          </div>
          {authState === 'disconnected' && (
            <Button type="button" className="icon-soft" onClick={() => void retrySigner()} aria-label="Retry signer">
              <RefreshCcw size={15} />
            </Button>
          )}
          {authState === 'connected' && (
            <Button type="button" className="icon-soft" onClick={() => void logoutSigner()} aria-label="Logout signer">
              <LogOut size={15} />
            </Button>
          )}
        </section>
      )}

      {authPrompt && (
        <Dialog open={showAuthPrompt} onOpenChange={(open) => !open && cancelAuthPrompt()}>
          <DialogContent className="auth-modal" showCloseButton={false}>
            <DialogHeader className="auth-modal-header">
              <div>
                <p className="eyebrow">nostr auth</p>
                <DialogTitle className="sr-only">Nostr sign in</DialogTitle>
                <h2>{authPrompt.title}</h2>
              </div>
              <Button type="button" className="icon-soft" onClick={cancelAuthPrompt} aria-label="Close auth prompt">
                <X size={15} />
              </Button>
            </DialogHeader>

            <DialogDescription className="auth-modal-copy">{authPrompt.detail}</DialogDescription>

            <div className="auth-status">
              <AvatarChip pubkey={selfPubkey} user={currentUser} small />
              <div>
                <strong>{authStatus}</strong>
                <span>{connectionMessage}</span>
              </div>
            </div>

            {connectSession && nostrConnectQr && authState === 'connecting' && (
              <Card className="connect-card" size="sm">
                <img src={nostrConnectQr} alt="Nostr Connect QR" />
                <span>Listening on {connectSession.relays.map(relayHostLabel).join(', ')}</span>
                <a href={connectSession.uri}>Open Nostr Connect</a>
              </Card>
            )}

            {authState === 'connecting' && !nostrConnectQr && (
              <div className="auth-pending">
                <LoaderCircle size={15} className="spin-icon" />
                Opening relay listener for Nostr Connect...
              </div>
            )}

            <div className="auth-actions">
              {authState === 'disconnected' ? (
                <>
                  <Button type="button" className="secondary-action" onClick={() => void retrySigner()}>
                    <RefreshCcw size={16} />
                    Retry
                  </Button>
                  <Button type="button" className="secondary-action danger" onClick={() => void logoutSigner()}>
                    <LogOut size={16} />
                    Logout
                  </Button>
                </>
              ) : (
                <Button type="button" className="secondary-action admin-wide" onClick={cancelAuthPrompt}>
                  Cancel
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}

      <nav className="app-rail" aria-label="Primary navigation">
        <Button
          type="button"
          className={`rail-button ${appView === 'dm' ? 'active' : ''}`}
          onClick={() => {
            setAppView('dm')
            setCallStarted(false)
            stopScreenShare()
            stopRemoteVideos()
            setCallExpanded(false)
          }}
          aria-label="Direct messages"
        >
          <Send size={23} />
        </Button>
        <div className="rail-divider" />
        <Button
          type="button"
          className={`rail-button relay ${appView !== 'dm' ? 'active' : ''}`}
          onClick={() => setAppView('relay')}
          aria-label={`Relay ${relayHost}`}
          title={relayHost}
        >
          <Radio size={22} />
        </Button>
      </nav>

      <aside
        className={`side-panel left-panel ${
          appView === 'dm' ? 'dm-sidebar' : appView === 'relay' ? 'relay-sidebar' : ''
        }`}
        aria-label={appView === 'dm' ? 'Direct messages' : appView === 'relay' ? 'Relay chats' : 'Office'}
      >
        {appView === 'dm' ? (
          <>
            <div className="brand-row">
              <div>
                <p className="eyebrow">private</p>
                <h1>Direct Messages</h1>
              </div>
              <span className="relay-dot" data-status={connectionStatus} />
            </div>

            <section className="panel-section dm-thread-list" aria-label="Direct message threads">
              <div className="section-title">
                <span>Threads</span>
                <span>{dmThreads.length} threads</span>
              </div>
              {dmThreads.length === 0 ? (
                <div className="empty-state">No direct messages have arrived yet.</div>
              ) : (
                dmThreads.map((thread) => {
                  const user = snapshot.users.find((candidate) => candidate.pubkey === thread.pubkey)
                  return (
                    <Button
                      key={thread.pubkey}
                      type="button"
                      className={`dm-thread ${activeDmPubkey === thread.pubkey ? 'active' : ''}`}
                      onClick={() => setActiveDmPubkey(thread.pubkey)}
                    >
                      <span className="avatar-stack">
                        <AvatarChip pubkey={thread.pubkey} user={user} />
                        <span
                          className={`presence-dot ${isOnline(thread.pubkey) ? 'online' : 'offline'}`}
                          title={isOnline(thread.pubkey) ? 'Online' : 'Offline'}
                        />
                      </span>
                      <span>
                        <strong>{nameFor(thread.pubkey, snapshot.users)}</strong>
                        <small>{thread.preview}</small>
                      </span>
                    </Button>
                  )
                })
              )}
            </section>
          </>
        ) : appView === 'relay' ? (
          <>
            <div className="brand-row">
              <div>
                <p className="eyebrow">relay</p>
                <h1>{relayHost}</h1>
              </div>
              <span className="relay-dot" data-status={connectionStatus} />
            </div>

            <section className="panel-section relay-channel-list" aria-label="Relay group chats">
              <div className="section-title">
                <span>Channels</span>
                <span>{relayGroupCountLabel}</span>
              </div>
              <Label className="relay-search">
                <Search size={15} />
                <Input
                  type="search"
                  value={relaySearch}
                  onChange={(event) => setRelaySearch(event.target.value)}
                  placeholder="Search groups"
                  aria-label="Search relay groups"
                />
              </Label>
              {relayGroups.length === 0 ? (
                <div className="empty-state">Waiting for chatrooms from this relay.</div>
              ) : filteredRelayGroups.length === 0 ? (
                <div className="empty-state">No groups match that search.</div>
              ) : (
                filteredRelayGroups.map((groupEvent) => {
                  const groupId = tagValue(groupEvent, 'd') ?? snapshot.group.id
                  const name = tagValue(groupEvent, 'name') ?? groupId

                  return (
                    <Button
                      type="button"
                      key={`${groupEvent.pubkey}:${groupId}`}
                      className={`relay-nav-row ${hasSelectedGroup && groupId === snapshot.group.id ? 'active' : ''}`}
                      onClick={() => selectRelayGroup(groupId)}
                    >
                      <MessageCircle size={16} />
                      <span>{name}</span>
                    </Button>
                  )
                })
              )}
            </section>
          </>
        ) : (
          <>
        <div className="brand-row">
          <div>
            <p className="eyebrow">{relayHost}</p>
            <h1>{metadataName}</h1>
          </div>
          <span className="relay-dot" data-status={connectionStatus} />
        </div>

        <p className="about">{groupAbout}</p>

        <div className="status-grid">
          <span>
            <LockKeyhole size={15} />
            {groupTagLabel(snapshot)}
          </span>
          <span>
            <Users size={15} />
            {groupMemberPubkeys.length} members
          </span>
        </div>

        {relay.mode === 'mock' && (
          <form className="signin" onSubmit={joinOffice}>
            <Label htmlFor="npub">npub</Label>
            <div className="input-row">
              <Input
                id="npub"
                value={npubInput}
                onChange={(event) => setNpubInput(event.target.value)}
                spellCheck={false}
              />
              <Button type="submit" aria-label="Join office">
                <LogIn size={18} />
              </Button>
            </div>
          </form>
        )}

        <section className="panel-section admin-panel" aria-label="Chatroom controls">
          <Card className="admin-card" size="sm">
            <div className="admin-status">
              <ShieldCheck size={16} />
              <span>{adminStatus}</span>
            </div>

            {!currentIsMember ? (
              <form className="admin-form" onSubmit={requestJoin}>
                <Label htmlFor="join-reason">Join request</Label>
                <Input
                  id="join-reason"
                  value={joinReason}
                  onChange={(event) => setJoinReason(event.target.value)}
                  placeholder="Reason"
                />
                <Input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value)}
                  placeholder="Invite code"
                  aria-label="Invite code"
                />
                <Button type="submit" className="secondary-action">
                  <DoorOpen size={16} />
                  Request
                </Button>
              </form>
            ) : (
              <Button type="button" className="secondary-action admin-wide" onClick={() => void leaveGroup()}>
                <DoorOpen size={16} />
                Leave group
              </Button>
            )}

            {canManageGroup && (
              <>
                {snapshot.joinRequests.length > 0 && (
                  <div className="admin-stack">
                    <Label>Pending joins</Label>
                    {snapshot.joinRequests.slice(0, 4).map((request) => (
                      <div className="join-request" key={request.id}>
                        <AvatarChip
                          pubkey={request.pubkey}
                          user={snapshot.users.find((user) => user.pubkey === request.pubkey)}
                          small
                        />
                        <span>{nameFor(request.pubkey, snapshot.users)}</span>
                        <Button
                          type="button"
                          className="icon-soft"
                          onClick={() => void acceptJoin(request.pubkey)}
                          aria-label={`Accept ${nameFor(request.pubkey, snapshot.users)}`}
                        >
                          <Check size={15} />
                        </Button>
                        <Button
                          type="button"
                          className="icon-soft danger"
                          onClick={() => void rejectJoin(request.pubkey)}
                          aria-label={`Reject ${nameFor(request.pubkey, snapshot.users)}`}
                        >
                          <UserMinus size={15} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <form className="admin-form" onSubmit={putUser}>
                  <Label htmlFor="admin-target">Member</Label>
                  <Input
                    id="admin-target"
                    value={targetInput}
                    onChange={(event) => setTargetInput(event.target.value)}
                    placeholder="npub or hex pubkey"
                    spellCheck={false}
                  />
                  <Input
                    value={targetRoles}
                    onChange={(event) => setTargetRoles(event.target.value)}
                    placeholder={supportedRoles.length ? supportedRoles.map((role) => role.name).join(', ') : 'roles'}
                    aria-label="Roles"
                  />
                  <div className="admin-row">
                    <Button type="submit" className="secondary-action">
                      <UserPlus size={16} />
                      Add
                    </Button>
                    <Button type="button" className="secondary-action danger" onClick={() => void removeUser()}>
                      <UserMinus size={16} />
                      Remove
                    </Button>
                  </div>
                </form>

                <form className="admin-form" onSubmit={createInvite}>
                  <Label htmlFor="invite-code">Invite</Label>
                  <div className="input-row">
                    <Input
                      id="invite-code"
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      spellCheck={false}
                    />
                    <Button type="submit" aria-label="Create invite">
                      <Ticket size={16} />
                    </Button>
                  </div>
                </form>

                <form className="admin-form" onSubmit={editMetadata}>
                  <Label htmlFor="group-name">Details</Label>
                  <Input
                    id="group-name"
                    value={metadataDraft.name}
                    onChange={(event) => setMetadataEdits((edits) => ({ ...edits, name: event.target.value }))}
                    placeholder="Group name"
                  />
                  <Input
                    value={metadataDraft.about}
                    onChange={(event) => setMetadataEdits((edits) => ({ ...edits, about: event.target.value }))}
                    placeholder="About"
                    aria-label="Group about"
                  />
                  <Input
                    value={metadataDraft.picture}
                    onChange={(event) => setMetadataEdits((edits) => ({ ...edits, picture: event.target.value }))}
                    placeholder="Picture URL"
                    aria-label="Group picture URL"
                  />
                  <div className="flag-grid">
                    {(['private', 'restricted', 'closed', 'hidden'] as const).map((flag) => (
                      <Label key={flag} className="flag-toggle">
                        <Checkbox
                          checked={metadataDraft[flag]}
                          onCheckedChange={(checked) =>
                            setMetadataEdits((edits) => ({ ...edits, [flag]: checked === true }))
                          }
                        />
                        {flag}
                      </Label>
                    ))}
                  </div>
                  <Button type="submit" className="secondary-action admin-wide">
                    <Edit3 size={16} />
                    Save details
                  </Button>
                </form>

                <div className="admin-form">
                  <Label htmlFor="delete-event">Moderation</Label>
                  <Input
                    id="delete-event"
                    value={eventIdInput}
                    onChange={(event) => setEventIdInput(event.target.value)}
                    placeholder="message id to delete"
                    spellCheck={false}
                  />
                  <div className="admin-row">
                    <Button type="button" className="secondary-action danger" onClick={() => void deleteEvent()}>
                      <Trash2 size={16} />
                      Delete message
                    </Button>
                  </div>
                  <div className="admin-row">
                    <Button type="button" className="secondary-action" onClick={() => void createGroup()}>
                      Create chatroom
                    </Button>
                    <Button type="button" className="secondary-action danger" onClick={() => void deleteGroup()}>
                      Delete chatroom
                    </Button>
                  </div>
                </div>

                {snapshot.moderationEvents.length > 0 && (
                  <div className="admin-stack">
                    <Label>Recent actions</Label>
                    {snapshot.moderationEvents.slice(0, 3).map((event) => (
                      <span className="admin-log" key={event.id}>{moderationSummary(event)}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </section>

        {showMesh && (
          <section className="panel-section">
            <div className="section-title">
              <span>Nearby mesh</span>
              <span className={`mesh-pill ${health}`}>{mesh.participants}</span>
            </div>
            <Card className="mesh-card" size="sm">
              <div>
                <strong>{callStarted ? 'P2P live' : 'P2P ready'}</strong>
                <p>{displayedMesh.connections} links · {displayedMesh.estimatedUploadMbps} Mbps uplink</p>
              </div>
              <Button
                type="button"
                className="primary-action"
                disabled={callPeers.length === 0}
                onClick={toggleCall}
                aria-label={callStarted ? 'Leave call' : 'Start call'}
              >
                {mediaState === 'requesting' ? (
                  <LoaderCircle size={18} className="spin-icon" />
                ) : callStarted ? (
                  <Mic size={18} />
                ) : (
                  <Video size={18} />
                )}
                {mediaState === 'requesting' ? 'Starting' : callStarted ? 'Leave' : 'Start'}
              </Button>
            </Card>
            <div className="nearby-list">
              {nearby.slice(0, 3).map((peer) => (
                <span key={peer.pubkey}>{nameFor(peer.pubkey, snapshot.users)}</span>
              ))}
            </div>
            {callStarted && <p className="call-note">{remoteVideos.length} mock peers streaming test video</p>}
          </section>
        )}

        <section className="panel-section people-list">
          <div className="section-title">
            <span>Members</span>
            <span>{mapCapacityLabel(activeCount)}</span>
          </div>
          {visiblePeople.map((user) => (
            <Button
              type="button"
              key={user.pubkey}
              className={`person ${user.pubkey === selfPubkey ? 'active' : ''}`}
              disabled={relay.mode === 'live' && user.pubkey !== selfPubkey}
              onClick={() => {
                if (relay.mode !== 'mock') return
                setSelfPubkey(user.pubkey)
                setNpubInput(user.npub)
                setCallStarted(false)
                stopScreenShare()
                stopRemoteVideos()
                setCallExpanded(false)
              }}
            >
              <span className="avatar-stack">
                <AvatarChip pubkey={user.pubkey} user={user} />
                <span
                  className={`presence-dot ${isOnline(user.pubkey) ? 'online' : 'offline'}`}
                  title={isOnline(user.pubkey) ? 'Online' : 'Offline'}
                />
              </span>
              <span>
                <strong>{user.pubkey === selfPubkey ? 'You' : user.name}</strong>
                <small>{user.role}</small>
              </span>
            </Button>
          ))}
        </section>
          </>
        )}
      </aside>

      {appView === 'group' && hasSelectedGroup && (
        <>
          <section className="world-panel map-panel" aria-label="Spatial office">
            <OfficeRenderer
              snapshot={{
                map: officeMap,
                users: snapshot.users,
                positions: snapshot.positions,
                selfPubkey,
              }}
              onMove={handleMove}
            />
            <div className="world-bottombar">
              <span>{currentUser?.name ?? 'guest'}</span>
              <span>{shortNpub(selfPubkey)}</span>
            </div>
            {callStarted && (
              <section
                ref={callStageRef}
                className={`call-stage ${callExpanded ? 'expanded' : ''}`}
                aria-label={relay.mode === 'mock' ? 'Mock call' : 'Call'}
              >
                <div className="call-stage-bar">
                  <div>
                    <strong>{relay.mode === 'mock' ? 'Mock call' : 'Call'}</strong>
                    <span>{displayedMesh.participants} participants · proximity call</span>
                  </div>
                  <Button
                    type="button"
                    className="icon-button"
                    onClick={toggleCallFullscreen}
                    aria-label={callExpanded ? 'Exit fullscreen call' : 'Fullscreen call'}
                  >
                    {callExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                  </Button>
                </div>
                <div className="media-controls" aria-label="Media controls">
                  <Button
                    type="button"
                    className={cameraEnabled ? '' : 'off'}
                    onClick={toggleCamera}
                    aria-label={cameraEnabled ? 'Disable camera' : 'Enable camera'}
                  >
                    {cameraEnabled ? <Camera size={18} /> : <CameraOff size={18} />}
                    <span>Camera</span>
                  </Button>
                  <Button
                    type="button"
                    className={micEnabled ? '' : 'off'}
                    onClick={toggleMic}
                    aria-label={micEnabled ? 'Mute microphone' : 'Enable microphone'}
                  >
                    {micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
                    <span>Mic</span>
                  </Button>
                  <Button
                    type="button"
                    className={screenStream ? 'active' : ''}
                    onClick={toggleScreenShare}
                    disabled={!canScreenShare}
                    aria-label={
                      !canScreenShare
                        ? 'Screen share unavailable'
                        : screenStream
                          ? 'Stop screen share'
                          : 'Start screen share'
                    }
                  >
                    <Monitor size={18} />
                    <span>Share</span>
                  </Button>
                </div>
                <div className="stream-grid">
                  <StreamTile
                    label={currentUser?.name ?? 'You'}
                    sublabel={
                      !cameraEnabled
                        ? 'camera off'
                        : mediaState === 'live'
                          ? 'local camera'
                          : mediaState === 'blocked'
                            ? 'camera blocked'
                            : 'requesting camera'
                    }
                    stream={cameraEnabled ? localStream : null}
                    muted
                    micMuted={!micEnabled}
                    status="local"
                  />
                  {screenStream && (
                    <StreamTile
                      label={`${currentUser?.name ?? 'You'} screen`}
                      sublabel="screen share"
                      stream={screenStream}
                      muted
                      micMuted
                      status="screen"
                    />
                  )}
                  {remoteVideos.map((video) => (
                    <StreamTile
                      key={video.pubkey}
                      label={video.name}
                      sublabel="mock peer stream"
                      stream={video.stream}
                      micMuted={Number.parseInt(video.pubkey.slice(0, 2), 16) % 4 === 0}
                    />
                  ))}
                </div>
              </section>
            )}
          </section>

          <aside className="side-panel chat-panel" aria-label="Chat">
            <div className="chat-header">
              <div>
                <h2>Chat</h2>
              </div>
              <MessageCircle size={22} />
            </div>

            <div className="messages" role="log" aria-label="Messages">
              {snapshot.messages.map((event) => {
                const sender = snapshot.users.find((user) => user.pubkey === event.pubkey)

                return (
                  <Card key={event.id} className="message" size="sm">
                    <div className="message-meta">
                      <AvatarChip pubkey={event.pubkey} user={sender} small />
                      <strong>{nameFor(event.pubkey, snapshot.users)}</strong>
                      <time>{new Date(event.created_at * 1000).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}</time>
                      {canManageGroup && (
                        <Button
                          type="button"
                          className="message-delete"
                          onClick={() => void deleteEvent(event.id)}
                          aria-label={`Delete message from ${nameFor(event.pubkey, snapshot.users)}`}
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                    <MessageContent event={event} users={snapshot.users} />
                  </Card>
                )
              })}
              <div ref={messagesEndRef} />
            </div>

            <form className="composer" onSubmit={sendMessage}>
              <Label htmlFor="message">Message</Label>
              <div className="input-row">
                <Input
                  id="message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Write to the room"
                />
                <Button type="submit" aria-label="Send message">
                  <Send size={18} />
                </Button>
              </div>
            </form>
          </aside>
        </>
      )}

      {appView === 'relay' && (
        <section className="world-panel relay-directory-panel" aria-label="Relay chats">
          <div className="directory-header">
            <div>
              <p className="eyebrow">relay</p>
              <h2>{relayHost}</h2>
            </div>
            <span>{relayGroupCountLabel} chats</span>
          </div>
          <Label className="relay-search directory-search">
            <Search size={15} />
            <Input
              type="search"
              value={relaySearch}
              onChange={(event) => setRelaySearch(event.target.value)}
              placeholder="Search groups"
              aria-label="Search relay groups"
            />
          </Label>
          <div className="relay-chat-grid">
            {relayGroups.length === 0 ? (
              <div className="empty-state">Waiting for chatrooms from this relay.</div>
            ) : filteredRelayGroups.length === 0 ? (
              <div className="empty-state">No groups match that search.</div>
            ) : (
              filteredRelayGroups.map((groupEvent) => {
                const groupId = tagValue(groupEvent, 'd') ?? snapshot.group.id
                const name = tagValue(groupEvent, 'name') ?? groupId
                const about = tagValue(groupEvent, 'about') ?? 'Chatroom'

                return (
                  <Button
                    type="button"
                    key={`${groupEvent.pubkey}:${groupId}`}
                    className={`relay-chat-card ${hasSelectedGroup && groupId === snapshot.group.id ? 'current' : ''}`}
                    onClick={() => selectRelayGroup(groupId)}
                  >
                    <span className="relay-chat-hash">#</span>
                    <span>
                      <strong>{name}</strong>
                      <small>{about}</small>
                    </span>
                  </Button>
                )
              })
            )}
          </div>
        </section>
      )}

      {appView === 'dm' && (
        <section className="world-panel dm-main-panel" aria-label="Direct messages">
          {activeDmPubkey ? (
            <>
              <div className="directory-header">
                <div>
                  <p className="eyebrow">dm</p>
                  <h2>{activeDmPeer?.name ?? nameFor(activeDmPubkey, snapshot.users)}</h2>
                </div>
                <Button type="button" className="dm-back" onClick={() => setActiveDmPubkey(null)}>
                  <ChevronLeft size={17} />
                  Threads
                </Button>
              </div>
              <div className="messages dm-messages" role="log" aria-label="Direct messages">
                {activeDmMessages.map((dm) => {
                  const outgoing = dm.senderPubkey === selfPubkey
                  const sender = snapshot.users.find((user) => user.pubkey === dm.senderPubkey)

                  return (
                    <Card key={dm.id} className={`message dm-message ${outgoing ? 'outgoing' : 'incoming'}`} size="sm">
                      <div className="message-meta">
                        <AvatarChip pubkey={dm.senderPubkey} user={sender} small />
                        <strong>{outgoing ? 'You' : nameFor(dm.senderPubkey, snapshot.users)}</strong>
                        <time>{new Date(dm.createdAt * 1000).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}</time>
                      </div>
                      <p>{dm.content}</p>
                    </Card>
                  )
                })}
                <div ref={dmMessagesEndRef} />
              </div>
              <form className="composer" onSubmit={sendDirectMessage}>
                <Label htmlFor="dm-message">Direct message</Label>
                <div className="input-row">
                  <Input
                    id="dm-message"
                    value={dmMessage}
                    onChange={(event) => setDmMessage(event.target.value)}
                    placeholder="Send a direct message"
                  />
                  <Button type="submit" aria-label="Send direct message">
                    <Send size={18} />
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <>
              <div className="directory-header">
                <div>
                  <p className="eyebrow">dm</p>
                  <h2>Direct Messages</h2>
                </div>
                <span>{dmThreads.length} threads</span>
              </div>
              <div className="dm-overview-grid">
                {dmThreads.length === 0 ? (
                  <div className="empty-state">No direct messages have arrived yet.</div>
                ) : (
                  dmThreads.map((thread) => {
                    const user = snapshot.users.find((candidate) => candidate.pubkey === thread.pubkey)
                    return (
                      <Button
                        key={thread.pubkey}
                        type="button"
                        className="dm-overview-card"
                        onClick={() => setActiveDmPubkey(thread.pubkey)}
                      >
                        <span className="avatar-stack">
                          <AvatarChip pubkey={thread.pubkey} user={user} />
                          <span
                            className={`presence-dot ${isOnline(thread.pubkey) ? 'online' : 'offline'}`}
                            title={isOnline(thread.pubkey) ? 'Online' : 'Offline'}
                          />
                        </span>
                        <span>
                          <strong>{nameFor(thread.pubkey, snapshot.users)}</strong>
                          <small>{thread.preview}</small>
                        </span>
                      </Button>
                    )
                  })
                )}
              </div>
            </>
          )}
        </section>
      )}
    </main>
    </TooltipProvider>
  )
}

export default App
