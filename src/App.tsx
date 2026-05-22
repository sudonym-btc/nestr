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
  Download,
  File as FileIcon,
  Image,
  Paperclip,
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
import { DEVELOPMENT_RELAYS, parseLaunch, type LiveLaunch, type MockLaunch } from './lib/launch'
import { createLiveRelay } from './lib/liveRelay'
import { createMockRelay, type MockUser, type RelaySnapshot } from './lib/mockRelay'
import { NIP29_KINDS, OFFICE_KINDS, hasTag, tagValue, type NestrAttachment, type NestrEvent, type NestrSigner } from './lib/nostr'
import {
  attachmentsFromEvent,
  contentWithoutAttachmentUrls,
} from './lib/attachments'
import { decryptAttachmentBlob, prepareFileAttachment } from './lib/blossomUpload'
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
import { BLOSSOM_FALLBACK_SERVERS } from './lib/profileImages'
import { estimateWebRtcMesh, nearbyPeers } from './lib/videoMesh'
import { buildOfficeMap, spawnForPubkey } from './lib/world'

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

function messageDate(seconds: number) {
  const date = new Date(seconds * 1000)
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }

  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric'
  return date.toLocaleString([], options)
}

function messageDateTime(seconds: number) {
  return new Date(seconds * 1000).toISOString()
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

function randomGroupId() {
  const bytes = new Uint8Array(8)
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

function trimRelayProtocol(relayUrl: string) {
  return relayUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '')
}

function relayGroupSearchText(groupEvent: NestrEvent, fallbackGroupId: string) {
  const groupId = tagValue(groupEvent, 'd') ?? fallbackGroupId
  const name = tagValue(groupEvent, 'name') ?? ''
  const about = tagValue(groupEvent, 'about') ?? ''
  return `${groupId} ${name} ${about}`.toLowerCase()
}

function isOfficeCallSignalKind(kind: number) {
  return (
    kind === OFFICE_KINDS.callOffer ||
    kind === OFFICE_KINDS.callAnswer ||
    kind === OFFICE_KINDS.iceCandidate ||
    kind === OFFICE_KINDS.callHangup
  )
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

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return 'file'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function relativePing(lastPingAt: number | null, nowMs: number, mode: 'mock' | 'live', authState: AuthState) {
  if (mode === 'mock') return 'local'
  if (authState === 'reconnecting') return 'reconnecting'
  if (authState === 'disconnected') return lastPingAt ? `last ping ${Math.max(1, Math.round((nowMs - lastPingAt) / 1000))}s ago` : 'offline'
  if (!lastPingAt) return 'not pinged yet'
  return `last ping ${Math.max(0, Math.round((nowMs - lastPingAt) / 1000))}s ago`
}

function attachmentPreviewKind(attachment: NestrAttachment) {
  if (attachment.mimeType.startsWith('image/')) return 'image'
  if (attachment.mimeType.startsWith('video/')) return 'video'
  if (attachment.mimeType.startsWith('audio/')) return 'audio'
  return 'file'
}

function AttachmentCard({ attachment }: { attachment: NestrAttachment }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const previewKind = attachmentPreviewKind(attachment)
  const needsObjectUrl = attachment.encrypted || attachment.url.startsWith('blob:') || attachment.url.startsWith('data:')
  const previewUrl = objectUrl ?? (!needsObjectUrl ? attachment.url : null)

  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null

    if (previewKind === 'file' && !attachment.encrypted) return undefined
    if (!needsObjectUrl && !attachment.encrypted) return undefined

    decryptAttachmentBlob(attachment)
      .then((blob) => {
        if (cancelled) return
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
        setStatus('idle')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [attachment, needsObjectUrl, previewKind])

  async function downloadAttachment() {
    try {
      setStatus('loading')
      const blob = await decryptAttachmentBlob(attachment)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = attachment.name
      link.rel = 'noreferrer'
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1200)
      setStatus('idle')
    } catch {
      window.open(attachment.url, '_blank', 'noopener,noreferrer')
      setStatus('error')
    }
  }

  return (
    <Card className={`attachment-card ${previewKind}`} size="sm">
      <div className="attachment-preview">
        {previewKind === 'image' && previewUrl ? (
          <img src={previewUrl} alt={attachment.alt || attachment.name} />
        ) : previewKind === 'video' && previewUrl ? (
          <video src={previewUrl} controls playsInline />
        ) : previewKind === 'audio' && previewUrl ? (
          <audio src={previewUrl} controls />
        ) : previewKind === 'image' ? (
          <Image size={18} />
        ) : (
          <FileIcon size={18} />
        )}
      </div>
      <div className="attachment-info">
        <strong>{attachment.name}</strong>
        <span>
          {attachment.encrypted ? 'encrypted · ' : ''}
          {attachment.mimeType} · {formatBytes(attachment.size)}
        </span>
      </div>
      <Button
        type="button"
        className="icon-soft attachment-download"
        onClick={() => void downloadAttachment()}
        aria-label={`Download ${attachment.name}`}
        title={status === 'loading' ? 'Preparing file' : `Download ${attachment.name}`}
      >
        {status === 'loading' ? <LoaderCircle size={15} className="spin-icon" /> : <Download size={15} />}
      </Button>
    </Card>
  )
}

function AttachmentGrid({ attachments }: { attachments: NestrAttachment[] }) {
  if (attachments.length === 0) return null

  return (
    <div className="attachment-grid">
      {attachments.map((attachment) => (
        <AttachmentCard key={`${attachment.url}:${attachment.name}`} attachment={attachment} />
      ))}
    </div>
  )
}

function SelectedFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (files.length === 0) return null

  return (
    <div className="selected-files" aria-label="Selected files">
      {files.map((file, index) => (
        <span className="selected-file" key={`${file.name}:${file.size}:${index}`}>
          <FileIcon size={13} />
          <span>{file.name}</span>
          <Button type="button" className="icon-soft" onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}>
            <X size={12} />
          </Button>
        </span>
      ))}
    </div>
  )
}

interface MessageContentProps {
  event: NestrEvent
  users: MockUser[]
}

function MessageContent({ event, users }: MessageContentProps) {
  const attachments = attachmentsFromEvent(event)
  const text = contentWithoutAttachmentUrls(event.content, attachments)
  const parts = parseNostrReferences(text, event.tags)

  return (
    <>
      {text && (
        <p>
          {parts.map((part, index) =>
            part.type === 'text' ? (
              <span key={`${index}-text`}>{part.text}</span>
            ) : (
              <NostrEntityChip key={`${index}-${part.code}`} entity={part} users={users} />
            ),
          )}
        </p>
      )}
      <AttachmentGrid attachments={attachments} />
    </>
  )
}

function DirectMessageContent({ message, users }: { message: { content: string; attachments?: NestrAttachment[] }; users: MockUser[] }) {
  const attachments = message.attachments ?? []
  const text = contentWithoutAttachmentUrls(message.content, attachments)
  const parts = parseNostrReferences(text, [])

  return (
    <>
      {text && (
        <p>
          {parts.map((part, index) =>
            part.type === 'text' ? (
              <span key={`${index}-text`}>{part.text}</span>
            ) : (
              <NostrEntityChip key={`${index}-${part.code}`} entity={part} users={users} />
            ),
          )}
        </p>
      )}
      <AttachmentGrid attachments={attachments} />
    </>
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
type AdminDialog = 'join' | 'member' | 'invite' | 'details' | 'moderation' | 'joins' | null

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

function relayBlockedKind(reason?: string) {
  const match = String(reason ?? '').match(/kind\s+(\d+)\s+not allowed/i)
  return match ? Number(match[1]) : null
}

function unsupportedActionMessage(kind: number, label: string) {
  if (kind === NIP29_KINDS.createInvite) return 'Invite codes are not supported by this relay.'
  return `${label} is not supported by this relay.`
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

function OfficeApp({ launch }: { launch: MockLaunch | LiveLaunch }) {
  const relay = useMemo(
    () =>
      launch.mode === 'live'
        ? createLiveRelay(launch.groupId, launch.relayUrl)
        : createMockRelay({
            relayUrl: launch.relayUrl,
            groupId: launch.groupId,
            persist: true,
            authRequired: launch.authRequired,
          }),
    [launch],
  )
  const [snapshot, setSnapshot] = useState(() => relay.snapshot())
  const [selfPubkey, setSelfPubkey] = useState(() => snapshot.users[0]?.pubkey ?? seededPubkey('live-viewer'))
  const [npubInput, setNpubInput] = useState<string>(() => npubForPubkey(snapshot.users[0]?.pubkey ?? selfPubkey))
  const [message, setMessage] = useState('')
  const [messageFiles, setMessageFiles] = useState<File[]>([])
  const [relaySearch, setRelaySearch] = useState('')
  const [appView, setAppView] = useState<AppView>(() =>
    launch.initialView,
  )
  const [activeDmPubkey, setActiveDmPubkey] = useState<string | null>(null)
  const [dmMessage, setDmMessage] = useState('')
  const [dmFiles, setDmFiles] = useState<File[]>([])
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
    launch.mode === 'live' ? 'opening live chatroom' : 'local development relay',
  )
  const [authDetail, setAuthDetail] = useState(() =>
    launch.mode === 'live' ? 'waiting for signer' : 'local development relay',
  )
  const [activeSigner, setActiveSigner] = useState<NestrSigner | null>(null)
  const [adminStatus, setAdminStatus] = useState('Chatroom controls ready')
  const [joinReason, setJoinReason] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [targetInput, setTargetInput] = useState('')
  const [targetRoles, setTargetRoles] = useState('')
  const [eventIdInput, setEventIdInput] = useState('')
  const [inviteCode, setInviteCode] = useState(() => randomInviteCode())
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupId, setNewGroupId] = useState(() => randomGroupId())
  const [metadataEdits, setMetadataEdits] = useState<Partial<Nip29MetadataDraft>>({})
  const [connectSession, setConnectSession] = useState<NostrConnectSession | null>(null)
  const [nostrConnectQr, setNostrConnectQr] = useState<string | null>(null)
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null)
  const [showAccountDialog, setShowAccountDialog] = useState(false)
  const [showCreateGroupDialog, setShowCreateGroupDialog] = useState(false)
  const [adminDialog, setAdminDialog] = useState<AdminDialog>(null)
  const [signerPillDismissed, setSignerPillDismissed] = useState(false)
  const [blockedAdminKinds, setBlockedAdminKinds] = useState<Set<number>>(() => new Set())
  const [lastSignerPingAt, setLastSignerPingAt] = useState<number | null>(() => (launch.mode === 'live' ? null : Date.now()))
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [uploadStatus, setUploadStatus] = useState('')
  const callStageRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const dmMessagesEndRef = useRef<HTMLDivElement | null>(null)
  const notifiedRef = useRef({ initialized: false, chat: new Set<string>(), dm: new Set<string>() })
  const autoAuthAttemptedRef = useRef(false)
  const authAttemptRef = useRef(0)
  const lastRelayAuthPromptRef = useRef('')
  const activeSignerRef = useRef<NestrSigner | null>(null)
  const connectSessionRef = useRef<NostrConnectSession | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteVideosRef = useRef<MockPeerVideo[]>([])
  const livePeerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const callPeersRef = useRef<Array<{ pubkey: string; name: string }>>([])
  const callStartedRef = useRef(false)
  const autoCallKeyRef = useRef('')
  const spawnPublishKeyRef = useRef('')
  const toggleCallRef = useRef<() => Promise<void>>(async () => undefined)
  const liveCallSignalRef = useRef<(event: NestrEvent) => void>(() => undefined)

  const activeCount = Math.max(snapshot.positions.length, snapshot.users.length)
  const officeMap = useMemo(
    () => buildOfficeMap(snapshot.group.id, activeCount),
    [snapshot.group.id, activeCount],
  )
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
  const roomAccessStatus = snapshot.roomAccessStatus ?? 'unknown'
  const roomAccessMessage = snapshot.roomAccessMessage ?? 'room not checked yet'
  const accountConnectionStatus =
    relay.mode === 'mock'
      ? 'mock'
      : authState === 'connected'
        ? 'connected'
        : authState === 'reconnecting' || authState === 'connecting'
          ? 'connecting'
          : authState === 'disconnected'
            ? 'disconnected'
            : connectionStatus
  const roomRelayLog = snapshot.connectionLog?.length ? snapshot.connectionLog.slice(0, 6) : [connectionMessage]
  const showAuthPrompt = relay.mode === 'live' && Boolean(authPrompt) && authState !== 'connected'
  const currentUser = snapshot.users.find((user) => user.pubkey === selfPubkey)
  const accountBlossomServers = currentUser?.blossomServers?.length
    ? currentUser.blossomServers
    : BLOSSOM_FALLBACK_SERVERS
  const accountDmRelays = currentUser?.dmRelays?.length
    ? currentUser.dmRelays
    : [snapshot.group.relay]
  const accountReadRelays = currentUser?.readRelays?.length
    ? currentUser.readRelays
    : [snapshot.group.relay]
  const accountWriteRelays = currentUser?.writeRelays?.length
    ? currentUser.writeRelays
    : [snapshot.group.relay]
  const groupMemberPubkeys = useMemo(() => memberPubkeys(snapshot.group.members), [snapshot.group.members])
  const groupMemberSet = useMemo(() => new Set(groupMemberPubkeys), [groupMemberPubkeys])
  const currentRoles = rolesForPubkey(snapshot, selfPubkey)
  const currentIsMember = groupMemberSet.has(selfPubkey) || currentRoles.length > 0
  const groupIsPrivate = hasTag(snapshot.group.metadata, 'private')
  const groupIsRestricted = hasTag(snapshot.group.metadata, 'restricted')
  const groupIsClosed = hasTag(snapshot.group.metadata, 'closed')
  const roomAccessPending = relay.mode === 'live' && roomAccessStatus === 'unknown'
  const relayDeniedRead = roomAccessStatus === 'blocked' || roomAccessStatus === 'auth-required'
  const canReadGroup = !roomAccessPending && !relayDeniedRead && (!groupIsPrivate || currentIsMember)
  const canWriteGroupChat = canReadGroup && !roomAccessPending && (!groupIsRestricted || currentIsMember)
  const canEnterOffice = canWriteGroupChat
  const officeUsers = useMemo(
    () => (canEnterOffice ? snapshot.users : snapshot.users.filter((user) => user.pubkey !== selfPubkey)),
    [canEnterOffice, selfPubkey, snapshot.users],
  )
  const officePositions = useMemo(
    () =>
      canEnterOffice
        ? snapshot.positions
        : snapshot.positions.filter((position) => position.pubkey !== selfPubkey),
    [canEnterOffice, selfPubkey, snapshot.positions],
  )
  const nearby = useMemo(
    () => (canEnterOffice ? nearbyPeers(selfPubkey, officePositions, 136) : []),
    [canEnterOffice, officePositions, selfPubkey],
  )
  const nearbyKey = nearby.map((peer) => peer.pubkey).sort().join('|')
  const signerDisplayName =
    currentUser?.name && currentUser.name !== 'You' ? currentUser.name : shortNpub(selfPubkey)
  const showSignerPill =
    relay.mode === 'live' &&
    (authState === 'reconnecting' ||
      authState === 'disconnected' ||
      (authState === 'connected' && !signerPillDismissed))
  const isSignedIn = relay.mode === 'mock' || authState === 'connected'
  const canOpenAccountPanel =
    relay.mode === 'mock' || authState === 'connected' || authState === 'disconnected' || authState === 'reconnecting'
  const signerPingLabel = relativePing(lastSignerPingAt, nowMs, relay.mode, authState)
  const showMesh = isSignedIn && nearby.length > 0
  const nearbyCallLabel =
    nearby.length === 1 ? nameFor(nearby[0].pubkey, snapshot.users) : `${nearby.length} plebs`
  const canManageGroup = currentRoles.length > 0 || currentUser?.role === 'admin' || currentUser?.role === 'moderator'
  const canUseChatroomActions = relay.mode === 'mock' || authState === 'connected'
  const canCreateRelayGroup = relay.mode === 'mock' || authState === 'connected'
  const canCreateInvite = canManageGroup && !blockedAdminKinds.has(NIP29_KINDS.createInvite)

  useEffect(() => {
    document.title =
      appView === 'group' && hasSelectedGroup
        ? `Nestr - ${metadataName}`
        : `Nestr - ${trimRelayProtocol(snapshot.group.relay)}`
  }, [appView, hasSelectedGroup, metadataName, snapshot.group.relay])
  const supportedRoles = supportedRoleTags(snapshot.group.roles)
  const visiblePeople = snapshot.users.filter(
    (user) => groupMemberSet.has(user.pubkey) || (canEnterOffice && user.pubkey === selfPubkey),
  )
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
    localStreamRef.current = localStream
  }, [localStream])

  useEffect(() => {
    callStartedRef.current = callStarted
  }, [callStarted])

  useEffect(() => {
    callPeersRef.current = callPeers
  }, [callPeers])

  useEffect(() => {
    const unsubscribe = relay.subscribe((next, event) => {
      setSnapshot(next)
      if (event) liveCallSignalRef.current(event)
    })
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
    if (!showAccountDialog && authState !== 'connected' && authState !== 'disconnected') return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [authState, showAccountDialog])

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

      await relay.setSigner(signer)
      activeSignerRef.current = signer
      setActiveSigner(signer)
      setSignerPillDismissed(false)
      setAuthState('connected')
      setSelfPubkey(signer.pubkey)
      setNpubInput(npubForPubkey(signer.pubkey))
      setCallStarted(false)
      livePeerConnectionsRef.current.forEach((connection) => connection.close())
      livePeerConnectionsRef.current.clear()
      pendingIceCandidatesRef.current.clear()
      remoteVideosRef.current.forEach((video) => video.stop())
      remoteVideosRef.current = []
      setRemoteVideos([])
      setCallExpanded(false)
      setAuthStatus(`Account connected as ${shortNpub(signer.pubkey)}`)
      setAuthDetail('signer online')
      setLastSignerPingAt(Date.now())
      setAuthPrompt(null)
      clearConnectSession()
    },
    [clearConnectSession, relay],
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
    if (relay.mode !== 'live') return undefined

    if (authState !== 'connected') return undefined
    const timer = window.setTimeout(() => setSignerPillDismissed(true), 3200)
    return () => window.clearTimeout(timer)
  }, [authState, relay.mode, selfPubkey])

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
        setLastSignerPingAt(Date.now())
      } catch (error) {
        markSignerDisconnected(errorMessage(error))
      }
    }

    void pingSigner()
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
    setLastSignerPingAt(null)
    setAuthPrompt(null)
    setShowAccountDialog(false)
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
      if (!canEnterOffice) return
      void relay.publishPosition(selfPubkey, position.x, position.y, position.vx, position.vy)
    },
    [canEnterOffice, relay, selfPubkey],
  )

  useEffect(() => {
    if (relay.mode !== 'live' || authState !== 'connected' || !hasSelectedGroup || !canEnterOffice) return
    if (snapshot.positions.some((position) => position.pubkey === selfPubkey)) return

    const spawnKey = `${snapshot.group.id}:${selfPubkey}`
    if (spawnPublishKeyRef.current === spawnKey) return
    spawnPublishKeyRef.current = spawnKey

    const spawn = spawnForPubkey(officeMap, selfPubkey, snapshot.users.length)
    void relay.publishPosition(selfPubkey, spawn.x, spawn.y, 0, 0).then((result) => {
      if (!result.ok && result.reason !== 'throttled' && result.reason !== 'group-required') {
        setAuthDetail(`position publish failed: ${result.reason}`)
      }
    })
  }, [
    authState,
    canEnterOffice,
    hasSelectedGroup,
    officeMap,
    relay,
    selfPubkey,
    snapshot.group.id,
    snapshot.positions,
    snapshot.users.length,
  ])

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

  function removeMessageFile(index: number) {
    setMessageFiles((files) => files.filter((_, candidateIndex) => candidateIndex !== index))
  }

  function removeDmFile(index: number) {
    setDmFiles((files) => files.filter((_, candidateIndex) => candidateIndex !== index))
  }

  async function prepareOutgoingFiles(files: File[], encrypt: boolean) {
    if (files.length === 0) return []
    if (relay.mode === 'live' && authState !== 'connected') {
      throw new Error('live-signer-required')
    }

    setUploadStatus(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}...`)
    const attachments = await Promise.all(
      files.map((file) =>
        prepareFileAttachment(file, {
          signer: activeSigner,
          servers: accountBlossomServers,
          encrypt,
          allowLocalFallback: relay.mode === 'mock',
        }),
      ),
    )
    setUploadStatus('')
    return attachments
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    if (!canWriteGroupChat) {
      setAdminDialog('join')
      return
    }

    let attachments: NestrAttachment[]
    try {
      attachments = await prepareOutgoingFiles(messageFiles, false)
    } catch (error) {
      if (signerRequired(errorMessage(error))) {
        requestAuth('write', `Sign in to upload files and publish messages to ${metadataName}.`)
      } else {
        setUploadStatus(errorMessage(error))
      }
      return
    }

    const result = await relay.publishGroupMessage(selfPubkey, message, attachments)
    if (!result.ok) {
      if (signerRequired(result.reason)) {
        requestAuth('write', `Sign in to publish messages to ${metadataName}. The message can be sent after auth completes.`)
      } else {
        setAuthStatus(String(result.reason))
      }
      return
    }
    setMessage('')
    setMessageFiles([])
  }

  async function sendDirectMessage(event: FormEvent) {
    event.preventDefault()
    if (!activeDmPubkey) return

    let attachments: NestrAttachment[]
    try {
      attachments = await prepareOutgoingFiles(dmFiles, true)
    } catch (error) {
      if (signerRequired(errorMessage(error))) {
        requestAuth('dm', 'Sign in to upload files and send encrypted direct messages.')
      } else {
        setUploadStatus(errorMessage(error))
      }
      return
    }

    const result = await relay.publishDirectMessage(selfPubkey, activeDmPubkey, dmMessage, attachments)
    if (!result.ok) {
      if (signerRequired(result.reason)) {
        requestAuth('dm', 'Sign in to send encrypted direct messages.')
      } else {
        setAuthStatus(String(result.reason))
      }
      return
    }

    setDmMessage('')
    setDmFiles([])
  }

  function selectRelayGroup(groupId: string) {
    if (relay.mode === 'mock') {
      relay.selectGroup(groupId)
      setAppView('group')
      return
    }

    if (hasSelectedGroup && groupId === snapshot.group.id) {
      setAppView('group')
      return
    }

    const url = new URL(window.location.href)
    url.searchParams.set('c', groupId)
    url.searchParams.set('relay', relayHostLabel(snapshot.group.relay))
    window.location.href = url.toString()
  }

  function handleAccountClick() {
    if (canOpenAccountPanel) {
      setShowAccountDialog(true)
      return
    }

    void beginLogin({
      kind: 'manual',
      title: authPromptTitle('manual'),
      detail: 'Connect a signer to use chatrooms, direct messages, and admin actions.',
    })
  }

  async function runNip29Action(
    label: string,
    action: () => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string },
    moderationKind?: number,
  ) {
    setAdminStatus(`${label}...`)
    try {
      const result = await action()
      const blockedKind = relayBlockedKind(result.reason)
      if (!result.ok && blockedKind) {
        setBlockedAdminKinds((current) => new Set(current).add(blockedKind))
        setAdminStatus(unsupportedActionMessage(blockedKind, label))
        if (moderationKind === blockedKind) setAdminDialog(null)
      } else {
        setAdminStatus(result.ok ? `${label} published` : `${label} failed: ${result.reason}`)
      }
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
    const ok = await runNip29Action('join request', () => relay.publishJoinRequest(selfPubkey, joinReason, joinCode))
    if (ok) {
      setJoinReason('')
      setJoinCode('')
      setAdminDialog(null)
    }
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

    const ok = await runNip29Action('member update', () =>
      relay.publishPutUser(selfPubkey, target, roleList(targetRoles), 'updated from nestr'),
    )
    if (ok) {
      setTargetInput('')
      setTargetRoles('')
      setAdminDialog(null)
    }
  }

  async function removeUser() {
    const target = targetPubkeyFromInput()
    if (!target) return

    const ok = await runNip29Action('remove member', () => relay.publishRemoveUser(selfPubkey, target, 'removed from nestr'))
    if (ok) {
      setTargetInput('')
      setTargetRoles('')
      setAdminDialog(null)
    }
  }

  async function acceptJoin(pubkey: string) {
    await runNip29Action('accept join', () => relay.publishPutUser(selfPubkey, pubkey, [], 'join accepted'))
  }

  async function rejectJoin(pubkey: string) {
    await runNip29Action('reject join', () => relay.publishRemoveUser(selfPubkey, pubkey, 'join rejected'))
  }

  async function editMetadata(event: FormEvent) {
    event.preventDefault()
    const ok = await runNip29Action('edit group', () =>
      relay.publishEditMetadata(selfPubkey, metadataDraft, 'metadata updated from nestr'),
    )
    if (ok) {
      setMetadataEdits({})
      setAdminDialog(null)
    }
  }

  async function deleteEvent(eventId = eventIdInput) {
    const trimmed = eventId.trim()
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
      setAdminStatus('Enter a 64-character event id')
      return
    }

    const ok = await runNip29Action('delete message', () =>
      relay.publishDeleteEvent(selfPubkey, trimmed, 'deleted from nestr'),
    )
    if (ok) {
      setEventIdInput('')
      setAdminDialog(null)
    }
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault()
    const ok = await runNip29Action('create invite', () =>
      relay.publishCreateInvite(selfPubkey, inviteCode, 'invite created from nestr'),
      NIP29_KINDS.createInvite,
    )
    if (ok) {
      setInviteCode(randomInviteCode())
      setAdminDialog(null)
    }
  }

  async function createRelayGroup(event: FormEvent) {
    event.preventDefault()
    const groupId = newGroupId.trim() || randomGroupId()
    const groupName = newGroupName.trim() || groupId
    const ok = await runNip29Action('create chatroom', () =>
      relay.publishCreateGroup(selfPubkey, groupName, groupId),
    )
    if (ok) {
      setNewGroupName('')
      setNewGroupId(randomGroupId())
      setShowCreateGroupDialog(false)
      selectRelayGroup(groupId)
    }
  }

  async function deleteGroup() {
    await runNip29Action('delete chatroom', () => relay.publishDeleteGroup(selfPubkey, 'group deleted from nestr'))
  }

  function targetForCallEvent(event: NestrEvent) {
    return event.tags.find((tag) => tag[0] === 'p' && tag[1])?.[1] ?? ''
  }

  function callSignalDescription(payload: unknown) {
    if (!payload || typeof payload !== 'object') return null
    const description = (payload as { description?: RTCSessionDescriptionInit }).description
    if (!description?.type || !description.sdp) return null
    return description
  }

  function callSignalCandidate(payload: unknown) {
    if (!payload || typeof payload !== 'object') return null
    const candidate = (payload as { candidate?: RTCIceCandidateInit }).candidate
    return candidate?.candidate ? candidate : null
  }

  function parseCallSignalPayload(event: NestrEvent) {
    try {
      return JSON.parse(event.content) as unknown
    } catch {
      return null
    }
  }

  async function publishLiveCallSignal(kind: number, targetPubkey: string, payload: unknown) {
    if (relay.mode !== 'live') return
    const result = await relay.publishCallSignal(selfPubkey, kind, targetPubkey, payload)
    if (!result.ok && result.reason !== 'throttled') setAuthDetail(`call signal failed: ${result.reason}`)
  }

  function upsertRemoteStream(pubkey: string, name: string, stream: MediaStream) {
    const existing = remoteVideosRef.current.find((video) => video.pubkey === pubkey)
    if (existing?.stream === stream) return
    const next = [
      ...remoteVideosRef.current.filter((video) => video.pubkey !== pubkey),
      {
        pubkey,
        name,
        stream,
        stop: () => stream.getTracks().forEach((track) => track.stop()),
      },
    ]
    replaceRemoteVideos(next)
  }

  function livePeerConnection(peerPubkey: string, peerName: string, stream: MediaStream) {
    const existing = livePeerConnectionsRef.current.get(peerPubkey)
    if (existing) return existing

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    stream.getTracks().forEach((track) => connection.addTrack(track, stream))
    connection.onicecandidate = (event) => {
      if (!event.candidate) return
      void publishLiveCallSignal(OFFICE_KINDS.iceCandidate, peerPubkey, {
        candidate: event.candidate.toJSON(),
      })
    }
    connection.ontrack = (event) => {
      const [remoteStream] = event.streams
      upsertRemoteStream(peerPubkey, peerName, remoteStream ?? new MediaStream([event.track]))
    }
    connection.onconnectionstatechange = () => {
      if (!['closed', 'failed', 'disconnected'].includes(connection.connectionState)) return
      livePeerConnectionsRef.current.delete(peerPubkey)
      setRemoteVideos((videos) => videos.filter((video) => video.pubkey !== peerPubkey))
      remoteVideosRef.current = remoteVideosRef.current.filter((video) => video.pubkey !== peerPubkey)
    }

    livePeerConnectionsRef.current.set(peerPubkey, connection)
    return connection
  }

  async function flushPendingIce(peerPubkey: string, connection: RTCPeerConnection) {
    const pending = pendingIceCandidatesRef.current.get(peerPubkey) ?? []
    pendingIceCandidatesRef.current.delete(peerPubkey)
    for (const candidate of pending) {
      await connection.addIceCandidate(candidate)
    }
  }

  async function ensureLiveCallMedia() {
    if (localStreamRef.current) return localStreamRef.current
    setCallStarted(true)
    setCameraEnabled(true)
    setMicEnabled(true)
    return requestLocalMedia(true, true)
  }

  async function startLivePeerConnections(stream: MediaStream | null) {
    if (!stream) return
    await Promise.all(
      callPeersRef.current.map(async (peer) => {
        if (peer.pubkey === selfPubkey) return
        const connection = livePeerConnection(peer.pubkey, peer.name, stream)
        if (selfPubkey > peer.pubkey || connection.signalingState !== 'stable') return

        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        await publishLiveCallSignal(OFFICE_KINDS.callOffer, peer.pubkey, {
          description: connection.localDescription,
        })
      }),
    )
  }

  async function handleLiveCallSignal(event: NestrEvent) {
    if (relay.mode !== 'live') return
    if (!isOfficeCallSignalKind(event.kind)) return
    if (event.pubkey === selfPubkey || targetForCallEvent(event) !== selfPubkey) return

    const peerPubkey = event.pubkey
    const peerName = nameFor(peerPubkey, snapshot.users)
    const payload = parseCallSignalPayload(event)

    if (event.kind === OFFICE_KINDS.callHangup) {
      livePeerConnectionsRef.current.get(peerPubkey)?.close()
      livePeerConnectionsRef.current.delete(peerPubkey)
      setRemoteVideos((videos) => videos.filter((video) => video.pubkey !== peerPubkey))
      remoteVideosRef.current = remoteVideosRef.current.filter((video) => video.pubkey !== peerPubkey)
      return
    }

    if (event.kind === OFFICE_KINDS.iceCandidate) {
      const candidate = callSignalCandidate(payload)
      if (!candidate) return
      const connection = livePeerConnectionsRef.current.get(peerPubkey)
      if (connection?.remoteDescription) await connection.addIceCandidate(candidate)
      else pendingIceCandidatesRef.current.set(peerPubkey, [
        ...(pendingIceCandidatesRef.current.get(peerPubkey) ?? []),
        candidate,
      ])
      return
    }

    const description = callSignalDescription(payload)
    if (!description) return
    const stream = await ensureLiveCallMedia()
    if (!stream) return
    const connection = livePeerConnection(peerPubkey, peerName, stream)

    if (event.kind === OFFICE_KINDS.callOffer) {
      await connection.setRemoteDescription(description)
      await flushPendingIce(peerPubkey, connection)
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      await publishLiveCallSignal(OFFICE_KINDS.callAnswer, peerPubkey, {
        description: connection.localDescription,
      })
      return
    }

    if (event.kind === OFFICE_KINDS.callAnswer && connection.signalingState === 'have-local-offer') {
      await connection.setRemoteDescription(description)
      await flushPendingIce(peerPubkey, connection)
    }
  }

  liveCallSignalRef.current = (event: NestrEvent) => {
    void handleLiveCallSignal(event)
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

  function stopLivePeerConnections(notifyPeers = false) {
    if (notifyPeers && relay.mode === 'live') {
      callPeersRef.current.forEach((peer) => {
        void publishLiveCallSignal(OFFICE_KINDS.callHangup, peer.pubkey, { reason: 'hangup' })
      })
    }
    livePeerConnectionsRef.current.forEach((connection) => connection.close())
    livePeerConnectionsRef.current.clear()
    pendingIceCandidatesRef.current.clear()
  }

  function stopRemoteVideos() {
    stopLivePeerConnections()
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
      return null
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
      return stream
    } catch {
      setMediaState('blocked')
      return null
    }
  }

  async function toggleCall() {
    if (callStarted) {
      stopLivePeerConnections(true)
      localStream?.getTracks().forEach((track) => track.stop())
      stopScreenShare()
      stopRemoteVideos()
      setLocalStream(null)
      localStreamRef.current = null
      setCallStarted(false)
      setCallExpanded(false)
      setMediaState('idle')
      return
    }

    setMediaState('requesting')
    setCameraEnabled(true)
    setMicEnabled(true)
    setCallStarted(true)
    const stream = await requestLocalMedia(true, true)
    if (relay.mode === 'mock') {
      replaceRemoteVideos(reconcileMockVideos(callPeerKey))
      return
    }
    await startLivePeerConnections(stream)
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

  useEffect(() => {
    toggleCallRef.current = toggleCall
  })

  useEffect(() => {
    if (!showMesh || callStarted || mediaState === 'requesting') return undefined
    if (!nearbyKey || autoCallKeyRef.current === nearbyKey) return undefined

    const timer = window.setTimeout(() => {
      autoCallKeyRef.current = nearbyKey
      void toggleCallRef.current()
    }, 240)

    return () => window.clearTimeout(timer)
  }, [callStarted, mediaState, nearbyKey, showMesh])

  return (
    <TooltipProvider>
    <main className="app-shell" data-auth-state={authState} data-view={appView}>
      {showSignerPill && (
        <section className={`signer-pill ${authState}`} aria-label="Signer status">
          <AvatarChip pubkey={selfPubkey} user={currentUser} small />
          <div>
            <strong>
              {authState === 'connected'
                ? `signed in ${signerDisplayName}`
                : authState === 'reconnecting'
                  ? 'reconnecting signer'
                  : 'signer disconnected'}
            </strong>
            <span>{authState === 'connected' ? `${shortNpub(selfPubkey)} · ${authDetail}` : authDetail}</span>
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

      <Dialog open={showAccountDialog} onOpenChange={setShowAccountDialog}>
        <DialogContent className="auth-modal account-modal">
          <DialogHeader className="auth-modal-header">
            <div>
              <p className="eyebrow">{relayHost}</p>
              <DialogTitle>Account</DialogTitle>
            </div>
          </DialogHeader>

          <section className="account-profile-card" aria-label="Profile">
            <AvatarChip pubkey={selfPubkey} user={currentUser} />
            <div>
              <strong>{signerDisplayName}</strong>
              <code>{npubForPubkey(selfPubkey)}</code>
            </div>
          </section>

          <section className={`account-signer-card ${authState}`} aria-label="Signer connection">
            <span className="relay-dot" data-status={accountConnectionStatus} />
            <div>
              <strong>
                {relay.mode === 'mock'
                  ? 'Local account'
                  : authState === 'connected'
                    ? 'Account connected'
                    : authState === 'reconnecting'
                      ? 'Account reconnecting'
                      : authState === 'disconnected'
                        ? 'Account disconnected'
                        : 'Account not connected'}
              </strong>
              <span>{signerPingLabel}</span>
            </div>
          </section>

          <div className="account-grid">
            <section className="account-info-card">
              <div className="section-title">
                <span>Room relay</span>
                <span>{connectionStatus}</span>
              </div>
              <code>{snapshot.group.relay}</code>
              <code>
                room: {roomAccessStatus === 'open' ? roomAccessMessage : `${roomAccessStatus} · ${roomAccessMessage}`}
              </code>
            </section>

            <section className="account-info-card wide relay-messages">
              <div className="section-title">
                <span>Room relay messages</span>
                <span>{roomRelayLog.length}</span>
              </div>
              {roomRelayLog.map((message) => (
                <code key={message}>{message}</code>
              ))}
            </section>

            <section className="account-info-card">
              <div className="section-title">
                <span>DM relays</span>
                <span>{accountDmRelays.length}</span>
              </div>
              {accountDmRelays.map((relayUrl) => (
                <code key={relayUrl}>{relayUrl}</code>
              ))}
            </section>

            <section className="account-info-card">
              <div className="section-title">
                <span>Read relays</span>
                <span>{accountReadRelays.length}</span>
              </div>
              {accountReadRelays.map((relayUrl) => (
                <code key={relayUrl}>{relayUrl}</code>
              ))}
            </section>

            <section className="account-info-card">
              <div className="section-title">
                <span>Write relays</span>
                <span>{accountWriteRelays.length}</span>
              </div>
              {accountWriteRelays.map((relayUrl) => (
                <code key={relayUrl}>{relayUrl}</code>
              ))}
            </section>

            <section className="account-info-card wide">
              <div className="section-title">
                <span>File servers</span>
                <span>{accountBlossomServers.length}</span>
              </div>
              {accountBlossomServers.map((server) => (
                <code key={server}>{server}</code>
              ))}
            </section>
          </div>

          <div className="auth-actions">
            {relay.mode === 'live' && authState === 'disconnected' && (
              <Button type="button" className="secondary-action" onClick={() => void retrySigner()}>
                <RefreshCcw size={16} />
                Retry
              </Button>
            )}
            {relay.mode === 'live' && (authState === 'connected' || authState === 'disconnected') && (
              <Button type="button" className="secondary-action danger" onClick={() => void logoutSigner()}>
                <LogOut size={16} />
                Logout
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateGroupDialog} onOpenChange={setShowCreateGroupDialog}>
        <DialogContent className="auth-modal create-chatroom-modal">
          <DialogHeader className="auth-modal-header">
            <div>
              <p className="eyebrow">{relayHost}</p>
              <DialogTitle>Create Chatroom</DialogTitle>
            </div>
          </DialogHeader>
          <DialogDescription className="auth-modal-copy">
            Ask this relay to create a new chatroom. Some relays may require you to sign in or have permission.
          </DialogDescription>
          <form className="admin-form" onSubmit={createRelayGroup}>
            <Input
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              placeholder="Name"
              aria-label="New chatroom name"
            />
            <Input
              value={newGroupId}
              onChange={(event) => setNewGroupId(event.target.value)}
              placeholder="Room id"
              aria-label="New chatroom id"
              spellCheck={false}
            />
            <div className="auth-actions">
              <Button type="button" className="secondary-action" onClick={() => setShowCreateGroupDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" className="primary-action">
                <MessageCircle size={16} />
                Create
              </Button>
            </div>
            <span className="admin-log">{adminStatus}</span>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={adminDialog !== null} onOpenChange={(open) => !open && setAdminDialog(null)}>
        <DialogContent className="auth-modal admin-action-modal">
          {adminDialog === 'join' && (
            <>
              <DialogHeader className="auth-modal-header">
                <div>
                  <p className="eyebrow">{metadataName}</p>
                  <DialogTitle>Join chatroom</DialogTitle>
                </div>
              </DialogHeader>
              <DialogDescription className="auth-modal-copy">
                {groupIsClosed
                  ? 'This chatroom is closed. Requests usually need an invite code from a moderator.'
                  : 'Send a request to the room moderators. Leave the invite code blank unless someone gave you one.'}
              </DialogDescription>
              <form className="admin-form" onSubmit={requestJoin}>
                <Input
                  value={joinReason}
                  onChange={(event) => setJoinReason(event.target.value)}
                  placeholder="Reason"
                  aria-label="Join reason"
                />
                <Input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value)}
                  placeholder={groupIsClosed ? 'Invite code' : 'Invite code (optional)'}
                  aria-label="Invite code"
                />
                <span className="form-hint">
                  {groupIsClosed
                    ? 'Closed chatrooms ignore normal requests unless the relay recognizes this code.'
                    : 'An invite code is a preapproval token created by a room admin. Most requests do not need one.'}
                </span>
                <Button type="submit" className="primary-action">
                  <DoorOpen size={16} />
                  Request
                </Button>
              </form>
            </>
          )}

          {adminDialog === 'member' && (
            <>
              <DialogHeader className="auth-modal-header">
                <div>
                  <p className="eyebrow">{metadataName}</p>
                  <DialogTitle>Add member</DialogTitle>
                </div>
              </DialogHeader>
              <DialogDescription className="auth-modal-copy">
                Add or update a person in this chatroom.
              </DialogDescription>
              <form className="admin-form" onSubmit={putUser}>
                <Input
                  value={targetInput}
                  onChange={(event) => setTargetInput(event.target.value)}
                  placeholder="npub or hex pubkey"
                  aria-label="Member pubkey"
                  spellCheck={false}
                />
                <Input
                  value={targetRoles}
                  onChange={(event) => setTargetRoles(event.target.value)}
                  placeholder={supportedRoles.length ? supportedRoles.map((role) => role.name).join(', ') : 'roles'}
                  aria-label="Roles"
                />
                <div className="admin-row">
                  <Button type="submit" className="primary-action">
                    <UserPlus size={16} />
                    Add
                  </Button>
                  <Button type="button" className="secondary-action danger" onClick={() => void removeUser()}>
                    <UserMinus size={16} />
                    Remove
                  </Button>
                </div>
              </form>
            </>
          )}

          {adminDialog === 'invite' && (
            <>
              <DialogHeader className="auth-modal-header">
                <div>
                  <p className="eyebrow">{metadataName}</p>
                  <DialogTitle>Create invite</DialogTitle>
                </div>
              </DialogHeader>
              <DialogDescription className="auth-modal-copy">
                Create an invite code that can be shared outside the room.
              </DialogDescription>
              <form className="admin-form" onSubmit={createInvite}>
                <Input
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  aria-label="Invite code"
                  spellCheck={false}
                />
                <Button type="submit" className="primary-action">
                  <Ticket size={16} />
                  Create invite
                </Button>
              </form>
            </>
          )}

          {adminDialog === 'details' && (
            <>
              <DialogHeader className="auth-modal-header">
                <div>
                  <p className="eyebrow">{metadataName}</p>
                  <DialogTitle>Edit group</DialogTitle>
                </div>
              </DialogHeader>
              <DialogDescription className="auth-modal-copy">
                Update this chatroom's name, description, picture, and visibility.
              </DialogDescription>
              <form className="admin-form" onSubmit={editMetadata}>
                <Input
                  value={metadataDraft.name}
                  onChange={(event) => setMetadataEdits((edits) => ({ ...edits, name: event.target.value }))}
                  placeholder="Group name"
                  aria-label="Group name"
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
                <Button type="submit" className="primary-action">
                  <Edit3 size={16} />
                  Save
                </Button>
              </form>
            </>
          )}

          {adminDialog === 'moderation' && (
            <>
              <DialogHeader className="auth-modal-header">
                <div>
                  <p className="eyebrow">{metadataName}</p>
                  <DialogTitle>Moderate chat</DialogTitle>
                </div>
              </DialogHeader>
              <DialogDescription className="auth-modal-copy">
                Remove a message by its event id.
              </DialogDescription>
              <div className="admin-form">
                <Input
                  value={eventIdInput}
                  onChange={(event) => setEventIdInput(event.target.value)}
                  placeholder="message id to delete"
                  aria-label="Message id"
                  spellCheck={false}
                />
                <Button type="button" className="secondary-action danger" onClick={() => void deleteEvent()}>
                  <Trash2 size={16} />
                  Delete message
                </Button>
              </div>
            </>
          )}

          {adminDialog === 'joins' && (
            <>
              <DialogHeader className="auth-modal-header">
                <div>
                  <p className="eyebrow">{metadataName}</p>
                  <DialogTitle>Review joins</DialogTitle>
                </div>
              </DialogHeader>
              <DialogDescription className="auth-modal-copy">
                Accept or reject people waiting to enter this chatroom.
              </DialogDescription>
              <div className="admin-stack">
                {snapshot.joinRequests.length === 0 ? (
                  <span className="admin-log">No pending joins.</span>
                ) : (
                  snapshot.joinRequests.map((request) => (
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
                  ))
                )}
              </div>
            </>
          )}

          <span className="admin-log">{adminStatus}</span>
        </DialogContent>
      </Dialog>

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
        <div className="rail-spacer" />
        <Button
          type="button"
          className={`rail-button account ${canOpenAccountPanel ? 'signed-in' : ''}`}
          onClick={handleAccountClick}
          aria-label={canOpenAccountPanel ? 'Account' : 'Sign in'}
          title={canOpenAccountPanel ? signerDisplayName : 'Sign in'}
        >
          {canOpenAccountPanel ? <AvatarChip pubkey={selfPubkey} user={currentUser} small /> : <LogIn size={22} />}
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

        {canUseChatroomActions && (
          <section className="panel-section admin-panel" aria-label="Chatroom controls">
            <Card className="admin-card" size="sm">
              <div className="admin-status">
                <ShieldCheck size={16} />
                <span>{adminStatus}</span>
              </div>

              <div className="admin-action-grid">
                {!currentIsMember ? (
                  <Button type="button" className="secondary-action" onClick={() => setAdminDialog('join')}>
                    <DoorOpen size={16} />
                    Join
                  </Button>
                ) : (
                  <Button type="button" className="secondary-action" onClick={() => void leaveGroup()}>
                    <DoorOpen size={16} />
                    Leave group
                  </Button>
                )}

                {canManageGroup && (
                  <>
                    {snapshot.joinRequests.length > 0 && (
                      <Button type="button" className="secondary-action" onClick={() => setAdminDialog('joins')}>
                        <Check size={16} />
                        Review joins
                      </Button>
                    )}
                    <Button type="button" className="secondary-action" onClick={() => setAdminDialog('member')}>
                      <UserPlus size={16} />
                      Add member
                    </Button>
                    {canCreateInvite && (
                      <Button type="button" className="secondary-action" onClick={() => setAdminDialog('invite')}>
                        <Ticket size={16} />
                        Invite
                      </Button>
                    )}
                    <Button type="button" className="secondary-action" onClick={() => setAdminDialog('details')}>
                      <Edit3 size={16} />
                      Edit group
                    </Button>
                    <Button type="button" className="secondary-action" onClick={() => setAdminDialog('moderation')}>
                      <Trash2 size={16} />
                      Moderate
                    </Button>
                    <Button type="button" className="secondary-action" onClick={() => setShowCreateGroupDialog(true)}>
                      <MessageCircle size={16} />
                      Create chatroom
                    </Button>
                    <Button type="button" className="secondary-action danger" onClick={() => void deleteGroup()}>
                      <Trash2 size={16} />
                      Delete chatroom
                    </Button>
                  </>
                )}
              </div>

              {canManageGroup && snapshot.moderationEvents.length > 0 && (
                <div className="admin-stack compact">
                  <Label>Recent actions</Label>
                  {snapshot.moderationEvents.slice(0, 3).map((event) => (
                    <span className="admin-log" key={event.id}>{moderationSummary(event)}</span>
                  ))}
                </div>
              )}
            </Card>
          </section>
        )}

        <section className="panel-section people-list">
          <div className="section-title">
            <span>Members</span>
            <span>{groupMemberPubkeys.length} members</span>
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

      {appView === 'group' && hasSelectedGroup && !canReadGroup && (
        <section className="world-panel access-panel" aria-label="Room access required">
          <Card className="access-card">
            <div className="access-icon">
              <LockKeyhole size={24} />
            </div>
            <div>
              <p className="eyebrow">{relayHost}</p>
              <h2>{roomAccessPending ? 'Checking chatroom access' : 'You do not have read access to this group'}</h2>
              <p>
                {roomAccessPending
                  ? 'Waiting for the relay to return the chatroom state.'
                  : roomAccessStatus === 'auth-required'
                  ? 'This relay wants you to sign in before it will return the room.'
                  : groupIsPrivate
                    ? 'This chatroom is private. Ask a moderator to add you or request access.'
                    : roomAccessMessage}
              </p>
            </div>
            {roomAccessPending ? null : canUseChatroomActions ? (
              <Button type="button" className="primary-action" onClick={() => setAdminDialog('join')}>
                <DoorOpen size={17} />
                Request access
              </Button>
            ) : (
              <Button
                type="button"
                className="primary-action"
                onClick={() => requestAuth('relay', `Sign in to check access to ${metadataName}.`)}
              >
                <LogIn size={17} />
                Sign in
              </Button>
            )}
          </Card>
        </section>
      )}

      {appView === 'group' && hasSelectedGroup && canReadGroup && (
        <>
          <section className="world-panel map-panel" aria-label="Spatial office">
            <OfficeRenderer
              snapshot={{
                map: officeMap,
                users: officeUsers,
                positions: officePositions,
                selfPubkey,
              }}
              canPlaceSelf={canEnterOffice}
              onMove={handleMove}
            />
            {!canEnterOffice && (
              <Card className="call-invite-card read-only-office" size="sm">
                <div>
                  <strong>Join to enter the office</strong>
                  <span>This chatroom is readable, but only members can appear on the map.</span>
                </div>
                <Button type="button" className="primary-action" onClick={() => setAdminDialog('join')}>
                  <DoorOpen size={17} />
                  Join
                </Button>
              </Card>
            )}
            {showMesh && !callStarted && (
              <Card className="call-invite-card" size="sm">
                <div>
                  <strong>Join call with {nearbyCallLabel}</strong>
                  <span>{displayedMesh.connections} links · auto-answer is on</span>
                </div>
                <Button
                  type="button"
                  className="primary-action"
                  disabled={callPeers.length === 0 || mediaState === 'requesting'}
                  onClick={toggleCall}
                  aria-label={`Join call with ${nearbyCallLabel}`}
                >
                  {mediaState === 'requesting' ? <LoaderCircle size={17} className="spin-icon" /> : <Video size={17} />}
                  {mediaState === 'requesting' ? 'Starting' : 'Join'}
                </Button>
              </Card>
            )}
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
                      sublabel={relay.mode === 'mock' ? 'mock peer stream' : 'peer camera'}
                      stream={video.stream}
                      micMuted={Number.parseInt(video.pubkey.slice(0, 2), 16) % 4 === 0}
                    />
                  ))}
                  {relay.mode === 'live' &&
                    remoteVideos.length === 0 &&
                    callPeers.map((peer) => (
                      <StreamTile
                        key={`pending-${peer.pubkey}`}
                        label={peer.name}
                        sublabel="connecting peer"
                        stream={null}
                        micMuted
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
                      <time dateTime={messageDateTime(event.created_at)}>{messageDate(event.created_at)}</time>
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
              {!canWriteGroupChat && (
                <span className="composer-lock">
                  This chatroom is readable, but only members can write.
                  <Button type="button" className="link-button" onClick={() => setAdminDialog('join')}>
                    Join
                  </Button>
                </span>
              )}
              <SelectedFiles files={messageFiles} onRemove={removeMessageFile} />
              <div className="input-row">
                <Input
                  id="message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={canWriteGroupChat ? 'Write to the room' : 'Join this chatroom to write'}
                  disabled={!canWriteGroupChat}
                />
                <Label
                  className={`file-picker ${canWriteGroupChat ? '' : 'disabled'}`}
                  aria-label="Attach files"
                  aria-disabled={!canWriteGroupChat}
                >
                  <Paperclip size={17} />
                  <input
                    type="file"
                    multiple
                    disabled={!canWriteGroupChat}
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? [])
                      setMessageFiles((current) => [...current, ...files])
                      event.currentTarget.value = ''
                    }}
                  />
                </Label>
                <Button type="submit" aria-label="Send message" disabled={!canWriteGroupChat}>
                  {uploadStatus ? <LoaderCircle size={18} className="spin-icon" /> : <Send size={18} />}
                </Button>
              </div>
              {uploadStatus && <span className="upload-status">{uploadStatus}</span>}
            </form>
          </aside>
        </>
      )}

      {appView === 'relay' && (
        <section className="world-panel relay-directory-panel" aria-label="Relay chats">
          <div className="directory-header">
            <div>
              <p className="eyebrow">relay</p>
              <div className="relay-title-row">
                <h2>{relayHost}</h2>
                <span className="relay-dot" data-status={connectionStatus} />
              </div>
            </div>
            <span>{relayGroupCountLabel} chats</span>
          </div>
          <div className="relay-toolbar">
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
            {canCreateRelayGroup && (
              <Button type="button" className="primary-action" onClick={() => setShowCreateGroupDialog(true)}>
                <MessageCircle size={16} />
                Create
              </Button>
            )}
          </div>
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
                        <time dateTime={messageDateTime(dm.createdAt)}>{messageDate(dm.createdAt)}</time>
                      </div>
                      <DirectMessageContent message={dm} users={snapshot.users} />
                    </Card>
                  )
                })}
                <div ref={dmMessagesEndRef} />
              </div>
              <form className="composer" onSubmit={sendDirectMessage}>
                <Label htmlFor="dm-message">Direct message</Label>
                <SelectedFiles files={dmFiles} onRemove={removeDmFile} />
                <div className="input-row">
                  <Input
                    id="dm-message"
                    value={dmMessage}
                    onChange={(event) => setDmMessage(event.target.value)}
                    placeholder="Send a direct message"
                  />
                  <Label className="file-picker" aria-label="Attach files">
                    <Paperclip size={17} />
                    <input
                      type="file"
                      multiple
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? [])
                        setDmFiles((current) => [...current, ...files])
                        event.currentTarget.value = ''
                      }}
                    />
                  </Label>
                  <Button type="submit" aria-label="Send direct message">
                    {uploadStatus ? <LoaderCircle size={18} className="spin-icon" /> : <Send size={18} />}
                  </Button>
                </div>
                {uploadStatus && <span className="upload-status">{uploadStatus}</span>}
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

function LandingApp() {
  useEffect(() => {
    document.title = 'Nestr'
  }, [])

  return (
    <TooltipProvider>
      <main className="app-shell landing-shell" data-view="landing">
        <nav className="app-rail" aria-label="Primary navigation">
          <Button type="button" className="rail-button active" aria-label="Relays">
            <Radio size={22} />
          </Button>
          <div className="rail-spacer" />
          <Button
            type="button"
            className="rail-button account"
            onClick={() => {
              window.location.href = '/?relay=relay.nestr.development'
            }}
            aria-label="Sign in"
          >
            <LogIn size={22} />
          </Button>
        </nav>

        <section className="world-panel relay-directory-panel landing-panel" aria-label="Relay directory">
          <div className="directory-header">
            <div>
              <p className="eyebrow">nestr</p>
              <div className="relay-title-row">
                <h2>Choose a relay</h2>
              </div>
            </div>
            <span>{DEVELOPMENT_RELAYS.length + 1} relays</span>
          </div>

          <div className="relay-chat-grid landing-relay-grid">
            {DEVELOPMENT_RELAYS.map((relay) => (
              <a
                key={relay.host}
                className="relay-chat-card landing-relay-card"
                href={`/?relay=${relay.host}`}
              >
                <span className="relay-chat-hash">
                  <Radio size={21} />
                </span>
                <span>
                  <strong>{relay.host}</strong>
                  <small>{relay.description}</small>
                </span>
              </a>
            ))}
            <a className="relay-chat-card landing-relay-card" href="/?relay=groups.0xchat.com">
              <span className="relay-chat-hash">
                <Radio size={21} />
              </span>
              <span>
                <strong>groups.0xchat.com</strong>
                <small>Live public group relay for testing real chatroom subscriptions.</small>
              </span>
            </a>
          </div>
        </section>
      </main>
    </TooltipProvider>
  )
}

function App() {
  const launch = useMemo(() => parseLaunch(), [])

  if (launch.mode === 'landing') return <LandingApp />
  return <OfficeApp launch={launch} />
}

export default App
