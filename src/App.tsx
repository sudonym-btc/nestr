import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as QRCode from 'qrcode'
import {
  Camera,
  CameraOff,
  Check,
  DoorOpen,
  Edit3,
  LockKeyhole,
  LogIn,
  LogOut,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  Radio,
  RefreshCcw,
  Send,
  ShieldCheck,
  Ticket,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Video,
} from 'lucide-react'
import './App.css'
import { PhaserOffice } from './game/PhaserOffice'
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
    <span
      className={`avatar-chip ${small ? 'small' : ''} ${src ? 'has-image' : ''}`}
      style={avatarCss(pubkey)}
    >
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed({ key: candidatesKey, index: candidateIndex + 1 })}
        />
      )}
    </span>
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
}

type AuthState = 'mock' | 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'disconnected'

function StreamTile({ label, sublabel, stream, muted = false }: StreamTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  return (
    <article className={`stream-tile ${stream ? '' : 'empty'}`}>
      {stream ? <video ref={videoRef} autoPlay muted={muted} playsInline /> : <div className="stream-empty" />}
      <div className="stream-label">
        <strong>{label}</strong>
        <span>{sublabel}</span>
      </div>
    </article>
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
  const [callStarted, setCallStarted] = useState(false)
  const [mediaState, setMediaState] = useState<'idle' | 'requesting' | 'live' | 'blocked'>('idle')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteVideos, setRemoteVideos] = useState<MockPeerVideo[]>([])
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [micEnabled, setMicEnabled] = useState(true)
  const [callExpanded, setCallExpanded] = useState(false)
  const [authState, setAuthState] = useState<AuthState>(() => (launch.mode === 'live' ? 'idle' : 'mock'))
  const [authStatus, setAuthStatus] = useState(() =>
    launch.mode === 'live' ? 'opening live NIP-29 room' : 'local mock relay',
  )
  const [authDetail, setAuthDetail] = useState(() =>
    launch.mode === 'live' ? 'waiting for signer' : 'local mock relay',
  )
  const [activeSigner, setActiveSigner] = useState<NestrSigner | null>(null)
  const [adminStatus, setAdminStatus] = useState('NIP-29 controls ready')
  const [joinReason, setJoinReason] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [targetInput, setTargetInput] = useState('')
  const [targetRoles, setTargetRoles] = useState('')
  const [eventIdInput, setEventIdInput] = useState('')
  const [inviteCode, setInviteCode] = useState(() => randomInviteCode())
  const [metadataEdits, setMetadataEdits] = useState<Partial<Nip29MetadataDraft>>({})
  const [connectSession, setConnectSession] = useState<NostrConnectSession | null>(null)
  const [nostrConnectQr, setNostrConnectQr] = useState<string | null>(null)
  const callStageRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const autoAuthAttemptedRef = useRef(false)
  const authAttemptRef = useRef(0)
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
  const metadataName = tagValue(snapshot.group.metadata, 'name') ?? 'NIP-29 office'
  const groupAbout = tagValue(snapshot.group.metadata, 'about') ?? ''
  const connectionStatus = snapshot.connectionStatus ?? relay.mode
  const connectionMessage = authDetail || snapshot.connectionMessage || authStatus
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
      clearConnectSession()

      const result = await relay.publishPosition(signer.pubkey, spawn.x, spawn.y, 0, 0)
      if (!result.ok && result.reason !== 'throttled') {
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

      if (storedSession) await writeStoredNostrConnectSession(storedSession)
      await applySigner(signer)
    },
    [applySigner],
  )

  const beginLogin = useCallback(async () => {
    if (relay.mode !== 'live') return

    const attempt = authAttemptRef.current + 1
    authAttemptRef.current = attempt
    activeSignerRef.current = null
    setActiveSigner(null)
    setAuthState('connecting')
    setAuthStatus(window.nostr ? 'asking NIP-07 signer' : 'waiting for Nostr Connect')
    setAuthDetail(window.nostr ? 'NIP-07 prompt open; QR also ready' : 'scan the QR with your signer')
    clearConnectSession()

    const session = startNostrConnect(relay.relayUrl)
    connectSessionRef.current = session
    setConnectSession(session)

    try {
      const dataUrl = await QRCode.toDataURL(session.uri, {
        margin: 1,
        width: 180,
        color: {
          dark: '#171922',
          light: '#fffdf8',
        },
      })
      setNostrConnectQr(dataUrl)
    } catch {
      setNostrConnectQr(null)
    }

    session.waitForSigner
      .then((result) => completeAuthAttempt(attempt, result.signer, result.storedSession))
      .catch((error) => {
        if (attempt !== authAttemptRef.current) return
        setAuthDetail(`Nostr Connect unavailable: ${errorMessage(error)}`)
      })

    if (window.nostr) {
      connectNip07Signer()
        .then((signer) => completeAuthAttempt(attempt, signer))
        .catch((error) => {
          if (attempt !== authAttemptRef.current) return
          setAuthStatus('waiting for Nostr Connect')
          setAuthDetail(`NIP-07 unavailable: ${errorMessage(error)}`)
        })
    }
  }, [clearConnectSession, completeAuthAttempt, relay])

  const beginAutoAuth = useCallback(async () => {
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

    await beginLogin()
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

  async function retrySigner() {
    if (relay.mode !== 'live') return
    setAuthDetail('retrying signer connection')
    await beginAutoAuth()
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
    stopRemoteVideos()
    setCallExpanded(false)
    setAuthState('idle')
    setAuthStatus('logged out')
    setAuthDetail('new Nostr Connect QR ready')
    await beginLogin()
  }

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
    stopRemoteVideos()
    setCallExpanded(false)
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const result = await relay.publishGroupMessage(selfPubkey, message)
    if (!result.ok) {
      setAuthStatus(
        result.reason === 'live-signer-required'
          ? 'connect a signer to write to this live room'
          : String(result.reason),
      )
      return
    }
    setMessage('')
  }

  async function runNip29Action(label: string, action: () => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }) {
    setAdminStatus(`${label}...`)
    try {
      const result = await action()
      setAdminStatus(result.ok ? `${label} published` : `${label} failed: ${result.reason}`)
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
    const ok = await runNip29Action('edit-metadata', () =>
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

  async function requestLocalMedia(nextCamera = cameraEnabled, nextMic = micEnabled) {
    localStream?.getTracks().forEach((track) => track.stop())
    setLocalStream(null)

    if (!nextCamera && !nextMic) {
      setMediaState('idle')
      return
    }

    setMediaState('requesting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: nextMic,
        video: nextCamera
          ? {
              width: { ideal: 640 },
              height: { ideal: 360 },
            }
          : false,
      })
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
    <main className="app-shell" data-auth-state={authState}>
      <aside className="side-panel left-panel" aria-label="Office">
        <div className="brand-row">
          <div>
            <p className="eyebrow">nestr</p>
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
          <span>
            <Radio size={15} />
            {connectionStatus}
          </span>
          <span>
            <MessageCircle size={15} />
            {snapshot.group.id}
          </span>
        </div>

        {relay.mode === 'mock' ? (
          <form className="signin" onSubmit={joinOffice}>
            <label htmlFor="npub">npub</label>
            <div className="input-row">
              <input
                id="npub"
                value={npubInput}
                onChange={(event) => setNpubInput(event.target.value)}
                spellCheck={false}
              />
              <button type="submit" aria-label="Join office">
                <LogIn size={18} />
              </button>
            </div>
          </form>
        ) : (
          <section className="signin live-auth" aria-label="Nostr auth">
            <label>nostr auth</label>
            <div className="auth-status">
              <AvatarChip pubkey={selfPubkey} user={currentUser} small />
              <div>
                <strong>{authStatus}</strong>
                <span>{connectionMessage}</span>
              </div>
            </div>
            {authState === 'disconnected' && (
              <div className="auth-actions">
                <button type="button" className="secondary-action" onClick={() => void retrySigner()}>
                  <RefreshCcw size={16} />
                  Retry
                </button>
                <button type="button" className="secondary-action danger" onClick={() => void logoutSigner()}>
                  <LogOut size={16} />
                  Logout
                </button>
              </div>
            )}
            {connectSession && nostrConnectQr && authState === 'connecting' && (
              <div className="connect-card">
                <img src={nostrConnectQr} alt="Nostr Connect QR" />
                <a href={connectSession.uri}>Open Nostr Connect</a>
              </div>
            )}
          </section>
        )}

        <section className="panel-section admin-panel" aria-label="NIP-29 controls">
          <div className="section-title">
            <span>NIP-29 controls</span>
            <span>{canManageGroup ? 'admin' : currentIsMember ? 'member' : 'visitor'}</span>
          </div>
          <div className="admin-card">
            <div className="admin-status">
              <ShieldCheck size={16} />
              <span>{adminStatus}</span>
            </div>

            {!currentIsMember ? (
              <form className="admin-form" onSubmit={requestJoin}>
                <label htmlFor="join-reason">Join request</label>
                <input
                  id="join-reason"
                  value={joinReason}
                  onChange={(event) => setJoinReason(event.target.value)}
                  placeholder="Reason"
                />
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value)}
                  placeholder="Invite code"
                  aria-label="Invite code"
                />
                <button type="submit" className="secondary-action">
                  <DoorOpen size={16} />
                  Request
                </button>
              </form>
            ) : (
              <button type="button" className="secondary-action admin-wide" onClick={() => void leaveGroup()}>
                <DoorOpen size={16} />
                Leave group
              </button>
            )}

            {canManageGroup && (
              <>
                {snapshot.joinRequests.length > 0 && (
                  <div className="admin-stack">
                    <label>Pending joins</label>
                    {snapshot.joinRequests.slice(0, 4).map((request) => (
                      <div className="join-request" key={request.id}>
                        <AvatarChip
                          pubkey={request.pubkey}
                          user={snapshot.users.find((user) => user.pubkey === request.pubkey)}
                          small
                        />
                        <span>{nameFor(request.pubkey, snapshot.users)}</span>
                        <button
                          type="button"
                          className="icon-soft"
                          onClick={() => void acceptJoin(request.pubkey)}
                          aria-label={`Accept ${nameFor(request.pubkey, snapshot.users)}`}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-soft danger"
                          onClick={() => void rejectJoin(request.pubkey)}
                          aria-label={`Reject ${nameFor(request.pubkey, snapshot.users)}`}
                        >
                          <UserMinus size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <form className="admin-form" onSubmit={putUser}>
                  <label htmlFor="admin-target">Member</label>
                  <input
                    id="admin-target"
                    value={targetInput}
                    onChange={(event) => setTargetInput(event.target.value)}
                    placeholder="npub or hex pubkey"
                    spellCheck={false}
                  />
                  <input
                    value={targetRoles}
                    onChange={(event) => setTargetRoles(event.target.value)}
                    placeholder={supportedRoles.length ? supportedRoles.map((role) => role.name).join(', ') : 'roles'}
                    aria-label="Roles"
                  />
                  <div className="admin-row">
                    <button type="submit" className="secondary-action">
                      <UserPlus size={16} />
                      Add
                    </button>
                    <button type="button" className="secondary-action danger" onClick={() => void removeUser()}>
                      <UserMinus size={16} />
                      Remove
                    </button>
                  </div>
                </form>

                <form className="admin-form" onSubmit={createInvite}>
                  <label htmlFor="invite-code">Invite</label>
                  <div className="input-row">
                    <input
                      id="invite-code"
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value)}
                      spellCheck={false}
                    />
                    <button type="submit" aria-label="Create invite">
                      <Ticket size={16} />
                    </button>
                  </div>
                </form>

                <form className="admin-form" onSubmit={editMetadata}>
                  <label htmlFor="group-name">Metadata</label>
                  <input
                    id="group-name"
                    value={metadataDraft.name}
                    onChange={(event) => setMetadataEdits((edits) => ({ ...edits, name: event.target.value }))}
                    placeholder="Group name"
                  />
                  <input
                    value={metadataDraft.about}
                    onChange={(event) => setMetadataEdits((edits) => ({ ...edits, about: event.target.value }))}
                    placeholder="About"
                    aria-label="Group about"
                  />
                  <input
                    value={metadataDraft.picture}
                    onChange={(event) => setMetadataEdits((edits) => ({ ...edits, picture: event.target.value }))}
                    placeholder="Picture URL"
                    aria-label="Group picture URL"
                  />
                  <div className="flag-grid">
                    {(['private', 'restricted', 'closed', 'hidden'] as const).map((flag) => (
                      <label key={flag} className="flag-toggle">
                        <input
                          type="checkbox"
                          checked={metadataDraft[flag]}
                          onChange={(event) =>
                            setMetadataEdits((edits) => ({ ...edits, [flag]: event.target.checked }))
                          }
                        />
                        {flag}
                      </label>
                    ))}
                  </div>
                  <button type="submit" className="secondary-action admin-wide">
                    <Edit3 size={16} />
                    Save metadata
                  </button>
                </form>

                <div className="admin-form">
                  <label htmlFor="delete-event">Moderation</label>
                  <input
                    id="delete-event"
                    value={eventIdInput}
                    onChange={(event) => setEventIdInput(event.target.value)}
                    placeholder="event id to delete"
                    spellCheck={false}
                  />
                  <div className="admin-row">
                    <button type="button" className="secondary-action danger" onClick={() => void deleteEvent()}>
                      <Trash2 size={16} />
                      Delete event
                    </button>
                  </div>
                  <div className="admin-row">
                    <button type="button" className="secondary-action" onClick={() => void createGroup()}>
                      Create group
                    </button>
                    <button type="button" className="secondary-action danger" onClick={() => void deleteGroup()}>
                      Delete group
                    </button>
                  </div>
                </div>

                {snapshot.moderationEvents.length > 0 && (
                  <div className="admin-stack">
                    <label>Recent actions</label>
                    {snapshot.moderationEvents.slice(0, 3).map((event) => (
                      <span className="admin-log" key={event.id}>{moderationSummary(event)}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {showMesh && (
          <section className="panel-section">
            <div className="section-title">
              <span>Nearby mesh</span>
              <span className={`mesh-pill ${health}`}>{mesh.participants}</span>
            </div>
            <div className="mesh-card">
              <div>
                <strong>{callStarted ? 'P2P live' : 'P2P ready'}</strong>
                <p>{displayedMesh.connections} links · {displayedMesh.estimatedUploadMbps} Mbps uplink</p>
              </div>
              <button
                type="button"
                className="primary-action"
                disabled={callPeers.length === 0}
                onClick={toggleCall}
                aria-label={callStarted ? 'Leave call' : 'Start call'}
              >
                {callStarted ? <Mic size={18} /> : <Video size={18} />}
                {callStarted ? 'Leave' : 'Start'}
              </button>
            </div>
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
            <button
              type="button"
              key={user.pubkey}
              className={`person ${user.pubkey === selfPubkey ? 'active' : ''}`}
              disabled={relay.mode === 'live' && user.pubkey !== selfPubkey}
              onClick={() => {
                if (relay.mode !== 'mock') return
                setSelfPubkey(user.pubkey)
                setNpubInput(user.npub)
                setCallStarted(false)
                stopRemoteVideos()
                setCallExpanded(false)
              }}
            >
              <AvatarChip pubkey={user.pubkey} user={user} />
              <span>
                <strong>{user.pubkey === selfPubkey ? 'You' : user.name}</strong>
                <small>{user.role}</small>
              </span>
            </button>
          ))}
        </section>
      </aside>

      <section className="world-panel" aria-label="Spatial office">
        <PhaserOffice
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
            aria-label={relay.mode === 'mock' ? 'Mock WebRTC call' : 'WebRTC call'}
          >
            <div className="call-stage-bar">
              <div>
                <strong>{relay.mode === 'mock' ? 'Mock WebRTC mesh' : 'WebRTC mesh'}</strong>
                <span>{displayedMesh.participants} participants · Nostr-signaled proximity call</span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={toggleCallFullscreen}
                aria-label={callExpanded ? 'Exit fullscreen call' : 'Fullscreen call'}
              >
                {callExpanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            </div>
            <div className="media-controls" aria-label="Media controls">
              <button
                type="button"
                className={cameraEnabled ? '' : 'off'}
                onClick={toggleCamera}
                aria-label={cameraEnabled ? 'Disable camera' : 'Enable camera'}
              >
                {cameraEnabled ? <Camera size={18} /> : <CameraOff size={18} />}
                <span>Camera</span>
              </button>
              <button
                type="button"
                className={micEnabled ? '' : 'off'}
                onClick={toggleMic}
                aria-label={micEnabled ? 'Mute microphone' : 'Enable microphone'}
              >
                {micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
                <span>Mic</span>
              </button>
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
              />
              {remoteVideos.map((video) => (
                <StreamTile
                  key={video.pubkey}
                  label={video.name}
                  sublabel="mock peer stream"
                  stream={video.stream}
                />
              ))}
            </div>
          </section>
        )}
      </section>

      <aside className="side-panel chat-panel" aria-label="Global NIP-29 chat">
        <div className="chat-header">
          <div>
            <p className="eyebrow">global</p>
            <h2>Chat</h2>
          </div>
          <MessageCircle size={22} />
        </div>

        <div className="messages" role="log" aria-label="Messages">
          {snapshot.messages.map((event) => {
            const sender = snapshot.users.find((user) => user.pubkey === event.pubkey)

            return (
              <article key={event.id} className="message">
                <div className="message-meta">
                  <AvatarChip pubkey={event.pubkey} user={sender} small />
                  <strong>{nameFor(event.pubkey, snapshot.users)}</strong>
                  <time>{new Date(event.created_at * 1000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}</time>
                  {canManageGroup && (
                    <button
                      type="button"
                      className="message-delete"
                      onClick={() => void deleteEvent(event.id)}
                      aria-label={`Delete message from ${nameFor(event.pubkey, snapshot.users)}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <MessageContent event={event} users={snapshot.users} />
              </article>
            )
          })}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <label htmlFor="message">Message</label>
          <div className="input-row">
            <input
              id="message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Write to the room"
            />
            <button type="submit" aria-label="Send message">
              <Send size={18} />
            </button>
          </div>
        </form>
      </aside>
    </main>
  )
}

export default App
