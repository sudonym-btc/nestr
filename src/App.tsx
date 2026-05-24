import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
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
  PhoneOff,
  Download,
  File as FileIcon,
  Image,
  Info,
  Paperclip,
  Plus,
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
import { DEVELOPMENT_RELAYS, parseLaunch, type LaunchConfig, type LiveLaunch, type MockLaunch } from './lib/launch'
import { createLiveRelay } from './lib/liveRelay'
import { createMockRelay, type MockUser, type RelaySnapshot } from './lib/mockRelay'
import { NIP29_KINDS, OFFICE_KINDS, hasTag, tagValue, type NestrAttachment, type NestrEvent, type NestrSigner } from './lib/nostr'
import {
  normalizeRelayUrl,
  readSavedRelayUrls,
  relayUrlFromGroupEvent,
  sameRelayUrl,
  uniqueRelayUrls,
  writeSavedRelayUrls,
} from './lib/relayDiscovery'
import { fetchRelayInfo, relayIconCandidates, type RelayInfo } from './lib/relayInfo'
import { filterFailedImages, markImageFailed } from './lib/imageFailures'
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
import { playCallJoinSound, playMessageSound, primeMessageSound } from './lib/messageSound'
import { isOnlineFromActivity } from './lib/presence'
import {
  contentSummary,
  debugDuration,
  debugError,
  debugLog,
  debugWarn,
  eventTagSummary,
  shortId,
} from './lib/debugLog'
import {
  connectNip07Signer,
  normalizeStoredNostrConnectSession,
  nostrConnectStoredRelayHints,
  restoreNostrConnectSigner,
  startNostrConnect,
  type NostrConnectSession,
  type NostrConnectStoredSession,
} from './lib/signers'
import {
  clearStoredNostrConnectSession,
  readStoredNostrConnectSession,
  writeStoredNostrConnectSession,
} from './lib/secureSession'
import { BLOSSOM_FALLBACK_SERVERS } from './lib/profileImages'
import { estimateWebRtcMesh, nearbyPeers } from './lib/videoMesh'
import { buildOfficeMap, spawnForPubkey } from './lib/world'
import {
  isPositionFresh,
  POSITION_REBROADCAST_INTERVAL_MS,
  type PositionMovement,
} from './lib/positionEvents'

const PEOPLE_RENDER_STEP = 80

function nameFor(pubkey: string, users: MockUser[]) {
  return users.find((user) => user.pubkey === pubkey)?.name ?? shortNpub(pubkey)
}

function appPath(url: URL) {
  return `${url.pathname}${url.search}${url.hash}`
}

function navigateInApp(target: string | URL) {
  const url = typeof target === 'string' ? new URL(target, window.location.href) : target
  if (url.origin !== window.location.origin) {
    window.location.href = url.toString()
    return
  }

  const nextPath = appPath(url)
  if (nextPath !== appPath(new URL(window.location.href))) {
    window.history.pushState(null, '', nextPath)
  }
  window.dispatchEvent(new Event('popstate'))
}

function handleInternalLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
    return
  }
  event.preventDefault()
  navigateInApp(event.currentTarget.href)
}

function launchKey(launch: LaunchConfig) {
  if (launch.mode === 'landing') return 'landing'
  if (launch.mode === 'live') return 'live'
  return [launch.mode, launch.relayUrl, launch.groupId ?? ''].join(':')
}

function groupNameHintKey(relayUrl: string, groupId: string) {
  return `${normalizeRelayUrl(relayUrl)}:${groupId}`
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

function isTimeoutError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  return message.includes('timeout') || message.includes('timed out')
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
  const relay = tagValue(groupEvent, 'relay') ?? ''
  return `${groupId} ${name} ${about} ${relay}`.toLowerCase()
}

const SIGNER_PENDING_DEFAULT_DELAY_MS = 5_000
const SIGNER_PENDING_CALL_DELAY_MS = 2_000
const SIGNER_PING_TIMEOUT_MS = 4_000
const SIGNER_PING_RETRY_DELAY_MS = 800

function isOfficeCallSignalKind(kind: number) {
  return (
    kind === OFFICE_KINDS.callOffer ||
    kind === OFFICE_KINDS.callAnswer ||
    kind === OFFICE_KINDS.iceCandidate ||
    kind === OFFICE_KINDS.callHangup ||
    kind === OFFICE_KINDS.callRenegotiate
  )
}

function signerPendingDelayMs(kind: number) {
  return isOfficeCallSignalKind(kind) ? SIGNER_PENDING_CALL_DELAY_MS : SIGNER_PENDING_DEFAULT_DELAY_MS
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
  const rawCandidates = user?.pictureCandidates?.length ? user.pictureCandidates : user?.pictureUrl ? [user.pictureUrl] : []
  const candidates = filterFailedImages(rawCandidates)
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
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoadingStatusChange={(status) => {
            if (status === 'error') {
              markImageFailed(src)
              setFailed({ key: candidatesKey, index: candidateIndex + 1 })
            }
          }}
        />
      )}
      <AvatarFallback />
    </Avatar>
  )
}

function relayInitials(relayUrl: string) {
  const host = relayHostLabel(relayUrl).replace(/^www\./, '')
  const parts = host.split('.').filter(Boolean)
  const source = parts.length > 1 ? parts.slice(0, -1) : parts
  const letters = source
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
  return letters || 'R'
}

interface RelayRailButtonProps {
  relayUrl: string
  active: boolean
  onClick: () => void
}

function RelayRailButton({ relayUrl, active, onClick }: RelayRailButtonProps) {
  const host = relayHostLabel(relayUrl)
  const [info, setInfo] = useState<RelayInfo | null>(null)
  const [iconIndex, setIconIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    void fetchRelayInfo(relayUrl).then((next) => {
      if (!cancelled) {
        if (next?.icon) setIconIndex(0)
        setInfo(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [relayUrl])

  const iconCandidates = filterFailedImages(relayIconCandidates(relayUrl, info))
  const iconUrl = iconCandidates[iconIndex] ?? null
  const label = info?.name || host

  return (
    <Button
      type="button"
      className={`rail-button relay ${active ? 'active' : ''} ${iconUrl ? 'has-logo' : ''}`}
      onClick={onClick}
      aria-label={`Relay ${label}`}
      title={label}
    >
      {iconUrl ? (
        <img
          className="relay-logo"
          src={iconUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => {
            markImageFailed(iconUrl)
            setIconIndex((index) => Math.min(index + 1, iconCandidates.length))
          }}
        />
      ) : (
        <span className="relay-initials" aria-hidden="true">{relayInitials(relayUrl)}</span>
      )}
    </Button>
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
  sublabel?: string
  stream: MediaStream | null
  showVideo?: boolean
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

interface SignerPendingPrompt {
  id: string
  signerLabel: string
  eventKind: number
}

interface CallMediaState {
  audio?: boolean
  video?: boolean
  screen?: boolean
}

type StoredPositionMovement = PositionMovement & { sentAt: number }

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

function directMessageErrorMessage(reason: unknown, recipientName: string) {
  if (reason === 'recipient-nip17-relays-missing') {
    return `${recipientName} has not published NIP-17 DM relays yet, so Nestr cannot send them a private reply.`
  }
  return String(reason)
}

function signerEventDescription(kind: number) {
  if (kind === OFFICE_KINDS.avatarPosition) return 'office movement'
  if (kind === OFFICE_KINDS.callOffer) return 'call offer'
  if (kind === OFFICE_KINDS.callAnswer) return 'call answer'
  if (kind === OFFICE_KINDS.iceCandidate) return 'call connection candidate'
  if (kind === OFFICE_KINDS.callHangup) return 'call hangup'
  if (kind === OFFICE_KINDS.callRenegotiate) return 'call media update'
  if (kind === NIP29_KINDS.chatMessage) return 'chat message'
  if (kind === NIP29_KINDS.joinRequest) return 'join request'
  if (kind === NIP29_KINDS.putUser) return 'member update'
  if (kind === NIP29_KINDS.removeUser) return 'member removal'
  if (kind === NIP29_KINDS.editMetadata) return 'group edit'
  if (kind === NIP29_KINDS.deleteEvent) return 'message deletion'
  if (kind === NIP29_KINDS.createGroup) return 'group creation'
  if (kind === NIP29_KINDS.deleteGroup) return 'group deletion'
  if (kind === NIP29_KINDS.createInvite) return 'invite creation'
  return `kind ${kind}`
}

function remoteStreamHasLiveVideo(stream: MediaStream) {
  return stream.getVideoTracks().some((track) => track.readyState === 'live' && !track.muted && track.enabled)
}

function remoteStreamMicMuted(stream: MediaStream) {
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) return true
  return audioTracks.every((track) => track.readyState !== 'live' || track.muted || !track.enabled)
}

function callSignalMedia(payload: unknown): CallMediaState | null {
  if (!payload || typeof payload !== 'object') return null
  const media = (payload as { media?: unknown }).media
  if (!media || typeof media !== 'object') return null
  const candidate = media as Record<string, unknown>
  const audio = typeof candidate.audio === 'boolean' ? candidate.audio : undefined
  const video = typeof candidate.video === 'boolean' ? candidate.video : undefined
  const screen = typeof candidate.screen === 'boolean' ? candidate.screen : undefined
  return audio === undefined && video === undefined && screen === undefined ? null : { audio, video, screen }
}

function callSignalParticipants(payload: unknown) {
  if (!payload || typeof payload !== 'object') return []
  const participants = (payload as { participants?: unknown }).participants
  if (!Array.isArray(participants)) return []
  return Array.from(new Set(participants.filter((pubkey): pubkey is string => typeof pubkey === 'string' && pubkey.length > 0)))
}

function StreamTile({
  label,
  sublabel,
  stream,
  showVideo = Boolean(stream),
  muted = false,
  micMuted = false,
  status = 'remote',
}: StreamTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoVisible = Boolean(stream && showVideo)

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  return (
    <Card className={`stream-tile ${videoVisible ? '' : 'empty'} ${status}`} size="sm">
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          muted={muted}
          playsInline
          className={videoVisible ? undefined : 'stream-video-hidden'}
        />
      )}
      {!videoVisible && <div className="stream-empty" />}
      <div className="stream-label">
        <strong>{label}</strong>
        {!videoVisible ? <span>{sublabel ?? 'no video'}</span> : sublabel ? <span>{sublabel}</span> : null}
      </div>
      <span className={`stream-mic ${micMuted ? 'muted' : ''}`} aria-label={micMuted ? `${label} muted` : `${label} unmuted`}>
        {micMuted ? <MicOff size={14} /> : <Mic size={14} />}
      </span>
    </Card>
  )
}

function OfficeApp({ launch }: { launch: MockLaunch | LiveLaunch }) {
  const relayAuthRequired = launch.mode === 'mock' ? launch.authRequired : false
  const groupNameHintsRef = useRef(new Map<string, string>())
  const groupNameHint =
    launch.mode === 'live' && launch.groupId
      ? groupNameHintsRef.current.get(groupNameHintKey(launch.relayUrl, launch.groupId))
      : undefined
  const relay = useMemo(
    () =>
      launch.mode === 'live'
        ? createLiveRelay(launch.groupId, launch.relayUrl, groupNameHint)
        : createMockRelay({
            relayUrl: launch.relayUrl,
            groupId: launch.groupId,
            persist: true,
            authRequired: relayAuthRequired,
          }),
    [groupNameHint, launch.groupId, launch.mode, launch.relayUrl, relayAuthRequired],
  )
  const [snapshot, setSnapshot] = useState(() => relay.snapshot())
  const [selfPubkey, setSelfPubkey] = useState(() => snapshot.users[0]?.pubkey ?? seededPubkey('live-viewer'))
  const [npubInput, setNpubInput] = useState<string>(() => npubForPubkey(snapshot.users[0]?.pubkey ?? selfPubkey))
  const [message, setMessage] = useState('')
  const [messageFiles, setMessageFiles] = useState<File[]>([])
  const [relaySearch, setRelaySearch] = useState('')
  const routeViewKey = `${launch.relayUrl}:${launch.groupId ?? ''}:${launch.initialView}`
  const [appViewState, setAppViewState] = useState<{ key: string; view: AppView }>(() => ({
    key: routeViewKey,
    view: launch.initialView,
  }))
  const appView = appViewState.key === routeViewKey ? appViewState.view : launch.initialView
  const setAppView = useCallback(
    (view: AppView) => setAppViewState({ key: routeViewKey, view }),
    [routeViewKey],
  )
  const [peopleRenderState, setPeopleRenderState] = useState({ key: '', limit: PEOPLE_RENDER_STEP })
  const [activeDmPubkey, setActiveDmPubkey] = useState<string | null>(null)
  const [dmMessage, setDmMessage] = useState('')
  const [dmFiles, setDmFiles] = useState<File[]>([])
  const [callStarted, setCallStarted] = useState(false)
  const [mediaState, setMediaState] = useState<'idle' | 'requesting' | 'live' | 'blocked'>('idle')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [remoteVideos, setRemoteVideos] = useState<MockPeerVideo[]>([])
  const [liveCallPeers, setLiveCallPeers] = useState<Array<{ pubkey: string; name: string }>>([])
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
  const [relayUrlInput, setRelayUrlInput] = useState('')
  const [metadataEdits, setMetadataEdits] = useState<Partial<Nip29MetadataDraft>>({})
  const [connectSession, setConnectSession] = useState<NostrConnectSession | null>(null)
  const [storedConnectSession, setStoredConnectSession] = useState<NostrConnectStoredSession | null>(null)
  const [nostrConnectQr, setNostrConnectQr] = useState<string | null>(null)
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null)
  const [showAccountDialog, setShowAccountDialog] = useState(false)
  const [showCreateGroupDialog, setShowCreateGroupDialog] = useState(false)
  const [showAddRelayDialog, setShowAddRelayDialog] = useState(false)
  const [adminDialog, setAdminDialog] = useState<AdminDialog>(null)
  const [signerPendingPrompt, setSignerPendingPrompt] = useState<SignerPendingPrompt | null>(null)
  const [mobileChatOpen, setMobileChatOpen] = useState(false)
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false)
  const [seenChatCount, setSeenChatCount] = useState(() => snapshot.messages.length)
  const [signerPillDismissed, setSignerPillDismissed] = useState(false)
  const [blockedAdminKinds, setBlockedAdminKinds] = useState<Set<number>>(() => new Set())
  const [lastSignerPingAt, setLastSignerPingAt] = useState<number | null>(() => (launch.mode === 'live' ? null : Date.now()))
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [storedRelayUrls, setStoredRelayUrls] = useState<string[]>(() =>
    launch.mode === 'live' ? uniqueRelayUrls([...readSavedRelayUrls(), launch.relayUrl]) : [launch.relayUrl],
  )
  const [uploadStatus, setUploadStatus] = useState('')
  const callStageRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const dmMessagesEndRef = useRef<HTMLDivElement | null>(null)
  const notifiedRef = useRef({ initialized: false, chat: new Set<string>(), dm: new Set<string>() })
  const autoAuthAttemptedRef = useRef(false)
  const authAttemptRef = useRef(0)
  const lastRelayAuthPromptRef = useRef('')
  const activeSignerRef = useRef<NestrSigner | null>(null)
  const appliedSignerRelayRef = useRef<{ relay: typeof relay; signer: NestrSigner } | null>(null)
  const connectSessionRef = useRef<NostrConnectSession | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const cameraEnabledRef = useRef(cameraEnabled)
  const micEnabledRef = useRef(micEnabled)
  const previousRelayRef = useRef(relay)
  const remoteVideosRef = useRef<MockPeerVideo[]>([])
  const liveCallPeersRef = useRef<Array<{ pubkey: string; name: string }>>([])
  const remoteMediaStatesRef = useRef<Map<string, CallMediaState>>(new Map())
  const livePeerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const liveVideoSendersRef = useRef<Map<string, RTCRtpSender>>(new Map())
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const callPeersRef = useRef<Array<{ pubkey: string; name: string }>>([])
  const liveParticipantAnnouncementTimerRef = useRef<number | null>(null)
  const lastOwnPositionRef = useRef<StoredPositionMovement | null>(null)
  const latestPositionsRef = useRef<RelaySnapshot['positions']>(snapshot.positions)
  const canEnterOfficeRef = useRef(false)
  const positionRefreshRef = useRef<() => void>(() => undefined)
  const positionRefreshFallbackInFlightRef = useRef(false)
  const callStartedRef = useRef(false)
  const autoCallKeyRef = useRef('')
  const spawnPublishKeyRef = useRef('')
  const roomLoginPromptedRef = useRef('')
  const signerPingInFlightRef = useRef<{ pubkey: string; startedAt: number } | null>(null)
  const toggleCallRef = useRef<() => Promise<void>>(async () => undefined)
  const liveCallSignalRef = useRef<(event: NestrEvent) => void>(() => undefined)
  const startLivePeerConnectionsRef = useRef<(stream: MediaStream | null) => Promise<void>>(async () => undefined)

  const officeMap = useMemo(
    () => buildOfficeMap(snapshot.group.id, 0),
    [snapshot.group.id],
  )
  const metadataName = tagValue(snapshot.group.metadata, 'name') ?? 'Chatroom'
  const groupAbout = tagValue(snapshot.group.metadata, 'about') ?? ''
  const relayHost = relayHostLabel(snapshot.group.relay)
  const snapshotRelayUrls = useMemo(
    () => snapshot.relayUrls ?? [snapshot.group.relay],
    [snapshot.group.relay, snapshot.relayUrls],
  )
  const savedRelayUrls = useMemo(
    () => uniqueRelayUrls([...storedRelayUrls, ...snapshotRelayUrls, snapshot.group.relay]),
    [snapshot.group.relay, snapshotRelayUrls, storedRelayUrls],
  )
  const savedRelayUrlsKey = savedRelayUrls.join('|')
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
  const accountSignerRelays = useMemo(
    () => uniqueRelayUrls([...(connectSession?.relays ?? []), ...nostrConnectStoredRelayHints(storedConnectSession)]),
    [connectSession, storedConnectSession],
  )
  const groupMemberPubkeys = useMemo(() => memberPubkeys(snapshot.group.members), [snapshot.group.members])
  const groupMemberSet = useMemo(() => new Set(groupMemberPubkeys), [groupMemberPubkeys])
  const currentRoles = rolesForPubkey(snapshot, selfPubkey)
  const currentIsMember = groupMemberSet.has(selfPubkey) || currentRoles.length > 0
  const groupIsPrivate = hasTag(snapshot.group.metadata, 'private')
  const groupIsClosed = hasTag(snapshot.group.metadata, 'closed')
  const roomAccessPending = relay.mode === 'live' && roomAccessStatus === 'unknown'
  const relayDeniedRead = roomAccessStatus === 'blocked' || roomAccessStatus === 'auth-required'
  const canReadGroup = !roomAccessPending && !relayDeniedRead && (!groupIsPrivate || currentIsMember)
  const canWriteGroupChat = canReadGroup && (relay.mode === 'mock' || currentIsMember)
  const canEnterOffice = canWriteGroupChat
  const officeUsers = useMemo(
    () => (canEnterOffice ? snapshot.users : snapshot.users.filter((user) => user.pubkey !== selfPubkey)),
    [canEnterOffice, selfPubkey, snapshot.users],
  )
  const officePositions = useMemo(
    () => {
      const freshPositions =
        relay.mode === 'live'
          ? snapshot.positions.filter((position) => isPositionFresh(position, nowMs))
          : snapshot.positions

      return canEnterOffice
        ? freshPositions
        : freshPositions.filter((position) => position.pubkey !== selfPubkey)
    },
    [canEnterOffice, nowMs, relay.mode, selfPubkey, snapshot.positions],
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

  useEffect(() => {
    if (relay.mode !== 'live') return undefined
    const timeout = window.setTimeout(() => {
      setStoredRelayUrls((current) => (current.join('|') === savedRelayUrlsKey ? current : savedRelayUrls))
      writeSavedRelayUrls(savedRelayUrls)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [relay.mode, savedRelayUrls, savedRelayUrlsKey])
  const supportedRoles = supportedRoleTags(snapshot.group.roles)
  const peopleListKey = `${appView}:${snapshot.group.relay}:${snapshot.group.id}`
  const peopleRenderLimit = peopleRenderState.key === peopleListKey ? peopleRenderState.limit : PEOPLE_RENDER_STEP
  const visiblePeople = useMemo(
    () => snapshot.users.filter(
      (user) => groupMemberSet.has(user.pubkey) || (canEnterOffice && user.pubkey === selfPubkey),
    ),
    [canEnterOffice, groupMemberSet, selfPubkey, snapshot.users],
  )
  const renderedPeople = useMemo(
    () => visiblePeople.slice(0, peopleRenderLimit),
    [peopleRenderLimit, visiblePeople],
  )
  const hiddenPeopleCount = Math.max(0, visiblePeople.length - renderedPeople.length)
  const isOnline = useCallback(
    (pubkey: string) => isOnlineFromActivity(pubkey, snapshot.presence, snapshot.positions),
    [snapshot.positions, snapshot.presence],
  )
  const officePresenceLabel = useMemo(() => {
    const onlineCount = visiblePeople.filter((user) => isOnline(user.pubkey)).length
    const officeCount = new Set(officePositions.map((position) => position.pubkey)).size
    return `${onlineCount} online / ${officeCount} in office`
  }, [isOnline, officePositions, visiblePeople])
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
  const displayedCallPeers = relay.mode === 'live' && callStarted ? liveCallPeers : callPeers
  const callPeerKey = displayedCallPeers.map((peer) => `${peer.pubkey}:${peer.name}`).join('|')
  const liveCallPeerKey = displayedCallPeers.map((peer) => peer.pubkey).join('|')
  const displayedMesh = estimateWebRtcMesh((callStarted ? displayedCallPeers.length : nearby.length) + 1)
  const frozenPeerPubkeys = remoteVideos.map((video) => video.pubkey).join('|')
  const remoteVideoPubkeys = useMemo(() => new Set(remoteVideos.map((video) => video.pubkey)), [remoteVideos])
  const canScreenShare = Boolean(navigator.mediaDevices?.getDisplayMedia)
  const localCallStream = screenStream ?? (cameraEnabled ? localStream : null)
  const unreadChatCount = Math.max(0, snapshot.messages.length - seenChatCount)

  useEffect(() => {
    localStreamRef.current = localStream
  }, [localStream])

  useEffect(() => {
    screenStreamRef.current = screenStream
  }, [screenStream])

  useEffect(() => {
    cameraEnabledRef.current = cameraEnabled
  }, [cameraEnabled])

  useEffect(() => {
    micEnabledRef.current = micEnabled
  }, [micEnabled])

  useEffect(() => {
    callStartedRef.current = callStarted
  }, [callStarted])

  useEffect(() => {
    callPeersRef.current = displayedCallPeers
  }, [displayedCallPeers])

  useEffect(() => {
    liveCallPeersRef.current = liveCallPeers
  }, [liveCallPeers])

  useEffect(() => {
    if (appView === 'group') return undefined
    const timeout = window.setTimeout(() => {
      setMobileChatOpen(false)
      setMobileDetailsOpen(false)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [appView])

  useEffect(() => {
    if (appView !== 'group' || !mobileChatOpen) return undefined
    const timeout = window.setTimeout(() => {
      setSeenChatCount(snapshot.messages.length)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [appView, mobileChatOpen, snapshot.messages.length])

  useEffect(() => {
    const unsubscribe = relay.subscribe((next, event) => {
      setSnapshot(next)
      if (event) liveCallSignalRef.current(event)
    })
    if (relay.mode === 'live') relay.start()
    return () => {
      unsubscribe()
      if (relay.mode === 'live') relay.close()
    }
  }, [relay])

  useEffect(() => {
    if (previousRelayRef.current === relay) return
    previousRelayRef.current = relay
    setCallStarted(false)
    setLiveCallPeers([])
    liveCallPeersRef.current = []
    setCallExpanded(false)
    setMediaState('idle')
    if (liveParticipantAnnouncementTimerRef.current !== null) {
      window.clearTimeout(liveParticipantAnnouncementTimerRef.current)
      liveParticipantAnnouncementTimerRef.current = null
    }
    livePeerConnectionsRef.current.forEach((connection) => connection.close())
    livePeerConnectionsRef.current.clear()
    liveVideoSendersRef.current.clear()
    pendingIceCandidatesRef.current.clear()
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    screenStreamRef.current = null
    setLocalStream(null)
    setScreenStream(null)
    remoteVideosRef.current.forEach((video) => video.stop())
    remoteVideosRef.current = []
    remoteMediaStatesRef.current.clear()
    setRemoteVideos([])
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
    if (!callStarted || relay.mode !== 'mock') return undefined

    const timer = window.setTimeout(() => {
      replaceRemoteVideos(reconcileMockVideos(callPeerKey))
    }, 0)

    return () => window.clearTimeout(timer)
  }, [callPeerKey, callStarted, relay.mode])

  useEffect(() => {
    if (!callStarted || relay.mode !== 'live' || !localStream) return undefined
    void startLivePeerConnectionsRef.current(localStream)
    return undefined
  }, [callStarted, liveCallPeerKey, localStream, relay.mode])

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

  const signerWithPendingPrompt = useCallback((signer: NestrSigner): NestrSigner => ({
    ...signer,
    signEvent: async (event) => {
      const promptId = `${Date.now()}:${Math.random().toString(16).slice(2)}`
      const startedAt = performance.now()
      const pendingDelay = signerPendingDelayMs(event.kind)
      let pending = true
      debugLog('signer', 'signEvent requested', {
        promptId,
        signer: signer.label,
        kind: event.kind,
        createdAt: event.created_at,
        tags: eventTagSummary(event.tags),
        content: contentSummary(event.kind, event.content),
        pendingDelayMs: pendingDelay,
      })
      const timer = window.setTimeout(() => {
        if (!pending) return
        debugWarn('signer', 'pending modal shown', {
          promptId,
          signer: signer.label,
          kind: event.kind,
          elapsedMs: debugDuration(startedAt),
        })
        setSignerPendingPrompt({
          id: promptId,
          signerLabel: signer.label,
          eventKind: event.kind,
        })
      }, pendingDelay)

      try {
        const signed = await signer.signEvent(event)
        debugLog('signer', 'signEvent resolved', {
          promptId,
          signer: signer.label,
          kind: event.kind,
          id: shortId(signed.id),
          pubkey: shortId(signed.pubkey),
          elapsedMs: debugDuration(startedAt),
        })
        return signed
      } catch (error) {
        debugError('signer', 'signEvent rejected', {
          promptId,
          signer: signer.label,
          kind: event.kind,
          elapsedMs: debugDuration(startedAt),
          error: errorMessage(error),
        })
        throw error
      } finally {
        pending = false
        window.clearTimeout(timer)
        debugLog('signer', 'pending modal cleared', {
          promptId,
          kind: event.kind,
          elapsedMs: debugDuration(startedAt),
        })
        setSignerPendingPrompt((current) => (current?.id === promptId ? null : current))
      }
    },
  }), [])

  const applySigner = useCallback(
    async (signer: NestrSigner) => {
      if (relay.mode !== 'live') return

      debugLog('auth', 'applySigner start', {
        pubkey: shortId(signer.pubkey),
        label: signer.label,
        relay: relay.relayUrl,
      })
      const pendingAwareSigner = signerWithPendingPrompt(signer)
      await relay.setSigner(pendingAwareSigner)
      appliedSignerRelayRef.current = { relay, signer: pendingAwareSigner }
      activeSignerRef.current = pendingAwareSigner
      setActiveSigner(pendingAwareSigner)
      setSignerPillDismissed(false)
      setAuthState('connected')
      setSelfPubkey(signer.pubkey)
      setNpubInput(npubForPubkey(signer.pubkey))
      setCallStarted(false)
      livePeerConnectionsRef.current.forEach((connection) => connection.close())
      livePeerConnectionsRef.current.clear()
      liveVideoSendersRef.current.clear()
      pendingIceCandidatesRef.current.clear()
      remoteVideosRef.current.forEach((video) => video.stop())
      remoteVideosRef.current = []
      remoteMediaStatesRef.current.clear()
      setRemoteVideos([])
      setCallExpanded(false)
      setAuthStatus(`Account connected as ${shortNpub(signer.pubkey)}`)
      setAuthDetail('signer online')
      setLastSignerPingAt(Date.now())
      setAuthPrompt(null)
      clearConnectSession()
      debugLog('auth', 'applySigner complete', {
        pubkey: shortId(signer.pubkey),
        label: signer.label,
      })
    },
    [clearConnectSession, relay, signerWithPendingPrompt],
  )

  const markSignerDisconnected = useCallback(
    (detail: string) => {
      debugWarn('auth', 'signer disconnected', { detail })
      activeSignerRef.current = null
      appliedSignerRelayRef.current = null
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
    async (attempt: number, signer: NestrSigner, storedSession?: NostrConnectStoredSession | null) => {
      debugLog('auth', 'completeAuthAttempt start', {
        attempt,
        currentAttempt: authAttemptRef.current,
        pubkey: shortId(signer.pubkey),
        label: signer.label,
        hasStoredSession: Boolean(storedSession),
      })
      if (attempt !== authAttemptRef.current) {
        debugWarn('auth', 'completeAuthAttempt ignored stale attempt', {
          attempt,
          currentAttempt: authAttemptRef.current,
        })
        await signer.close?.()
        return
      }
      if (activeSignerRef.current) {
        debugWarn('auth', 'completeAuthAttempt ignored because signer already active', {
          activePubkey: shortId(activeSignerRef.current.pubkey),
          incomingPubkey: shortId(signer.pubkey),
        })
        await signer.close?.()
        return
      }

      if (storedSession) {
        const normalizedSession = normalizeStoredNostrConnectSession(storedSession)
        debugLog('auth', 'writing stored Nostr Connect session', {
          pubkey: shortId(normalizedSession.userPubkey),
          relays: nostrConnectStoredRelayHints(normalizedSession),
        })
        await writeStoredNostrConnectSession(normalizedSession)
        setStoredConnectSession(normalizedSession)
      }
      await applySigner(signer)
      debugLog('auth', 'completeAuthAttempt done', {
        attempt,
        pubkey: shortId(signer.pubkey),
      })
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

    const startNostrConnectListener = (restartReason?: string) => {
      clearConnectSession()
      const session = startNostrConnect({
        roomRelayUrl: relay.relayUrl,
        nostrConnectRelays: launch.mode === 'live' ? launch.nostrConnectRelays : undefined,
      })
      const relayList = session.relays.map(relayHostLabel).join(', ')
      let restartQueued = false
      connectSessionRef.current = session
      setConnectSession(session)
      setNostrConnectQr(null)
      setAuthStatus('waiting for Nostr Connect')
      setAuthDetail(
        restartReason
          ? `${restartReason}; opening fresh listener on ${relayList}`
          : `opening listener on ${relayList}`,
      )

      const shouldIgnoreSession = () =>
        attempt !== authAttemptRef.current || activeSignerRef.current || connectSessionRef.current !== session

      const restartAfterTimeout = (error: unknown) => {
        if (shouldIgnoreSession() || restartQueued || !isTimeoutError(error)) return false
        restartQueued = true
        setAuthStatus('waiting for Nostr Connect')
        setAuthDetail(`Nostr Connect timed out; restarting listener on ${relayList}`)
        window.setTimeout(() => {
          if (!shouldIgnoreSession()) startNostrConnectListener('Nostr Connect restarted after timeout')
        }, 0)
        return true
      }

      session.ready
        .then(async () => {
          if (shouldIgnoreSession()) return
          setAuthDetail(`scan QR; listening on ${relayList}`)
          try {
            const svg = await QRCode.toString(session.uri, {
              type: 'svg',
              margin: 4,
              errorCorrectionLevel: 'M',
              color: {
                dark: '#000000',
                light: '#ffffff',
              },
            })
            const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
            if (!shouldIgnoreSession()) setNostrConnectQr(dataUrl)
          } catch {
            if (!shouldIgnoreSession()) setNostrConnectQr(null)
          }
        })
        .catch((error) => {
          if (shouldIgnoreSession() || restartAfterTimeout(error)) return
          setAuthStatus('Nostr Connect listener failed')
          setAuthDetail(errorMessage(error))
        })

      session.waitForSigner
        .then((result) => completeAuthAttempt(attempt, result.signer, result.storedSession))
        .catch((error) => {
          if (shouldIgnoreSession() || restartAfterTimeout(error)) return
          setAuthDetail(`Nostr Connect unavailable: ${errorMessage(error)}`)
        })

      return session
    }

    const session = startNostrConnectListener()

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
          if (isTimeoutError(error) && connectSessionRef.current === session) {
            startNostrConnectListener('browser signer timed out')
            return
          }
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
    debugLog('auth', 'beginAutoAuth start', { attempt, interactiveFallback, relay: relay.relayUrl })
    const storedSession = await readStoredNostrConnectSession()
    const normalizedStoredSession = storedSession ? normalizeStoredNostrConnectSession(storedSession) : null

    if (attempt !== authAttemptRef.current) return
    setStoredConnectSession(normalizedStoredSession)
    debugLog('auth', 'stored Nostr Connect session read', {
      attempt,
      found: Boolean(normalizedStoredSession),
      pubkey: shortId(normalizedStoredSession?.userPubkey),
      relays: nostrConnectStoredRelayHints(normalizedStoredSession),
    })

    if (normalizedStoredSession) {
      const restoreRelays = nostrConnectStoredRelayHints(normalizedStoredSession).map(relayHostLabel).join(', ')
      const restoreStartedAt = performance.now()
      setAuthState('reconnecting')
      setAuthStatus('reconnecting signer')
      setAuthDetail(
        `restoring ${shortNpub(normalizedStoredSession.userPubkey)}${restoreRelays ? ` via ${restoreRelays}` : ''}`,
      )
      try {
        debugLog('auth', 'restore signer probe start', {
          attempt,
          pubkey: shortId(normalizedStoredSession.userPubkey),
          relays: nostrConnectStoredRelayHints(normalizedStoredSession),
        })
        const result = await withTimeout(
          restoreNostrConnectSigner(normalizedStoredSession),
          9_000,
          'signer reconnect timed out',
        )
        debugLog('auth', 'restore signer probe success', {
          attempt,
          pubkey: shortId(result.signer.pubkey),
          elapsedMs: debugDuration(restoreStartedAt),
        })
        await completeAuthAttempt(attempt, result.signer, result.storedSession)
        return
      } catch (error) {
        if (attempt !== authAttemptRef.current) return
        debugError('auth', 'restore signer probe failed', {
          attempt,
          elapsedMs: debugDuration(restoreStartedAt),
          error: errorMessage(error),
        })
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
    if (relay.mode !== 'live' || authState !== 'connected' || !activeSigner) return
    const applied = appliedSignerRelayRef.current
    if (applied?.relay === relay && applied.signer === activeSigner) {
      relay.refreshDirectMessageSubscriptions()
      return
    }
    relay.setSigner(activeSigner)
    appliedSignerRelayRef.current = { relay, signer: activeSigner }
  }, [activeSigner, authState, relay])

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
    let cancelled = false

    const pingSigner = async () => {
      const signer = activeSigner
      const startedAt = performance.now()
      const inFlight = signerPingInFlightRef.current
      if (inFlight?.pubkey === signer.pubkey) {
        debugWarn('auth', 'signer ping skipped; previous probe still in flight', {
          pubkey: shortId(signer.pubkey),
          inFlightMs: debugDuration(inFlight.startedAt),
        })
        return
      }
      signerPingInFlightRef.current = { pubkey: signer.pubkey, startedAt }
      const pingCurrentSigner = () =>
        withTimeout(signer.ping?.() ?? Promise.resolve(), SIGNER_PING_TIMEOUT_MS, 'signer ping timed out')

      try {
        debugLog('auth', 'signer ping start', {
          pubkey: shortId(signer.pubkey),
          label: signer.label,
          timeoutMs: SIGNER_PING_TIMEOUT_MS,
        })
        await pingCurrentSigner()
        debugLog('auth', 'signer ping ok', {
          pubkey: shortId(signer.pubkey),
          elapsedMs: debugDuration(startedAt),
        })
        setLastSignerPingAt(Date.now())
      } catch {
        debugWarn('auth', 'signer ping first attempt failed; retrying', {
          pubkey: shortId(signer.pubkey),
          elapsedMs: debugDuration(startedAt),
          retryDelayMs: SIGNER_PING_RETRY_DELAY_MS,
        })
        await new Promise((resolve) => window.setTimeout(resolve, SIGNER_PING_RETRY_DELAY_MS))
        if (cancelled || activeSignerRef.current !== signer) return

        try {
          debugLog('auth', 'signer ping retry start', {
            pubkey: shortId(signer.pubkey),
            timeoutMs: SIGNER_PING_TIMEOUT_MS,
          })
          await pingCurrentSigner()
          debugLog('auth', 'signer ping retry ok', {
            pubkey: shortId(signer.pubkey),
            elapsedMs: debugDuration(startedAt),
          })
          setLastSignerPingAt(Date.now())
        } catch (error) {
          if (cancelled || activeSignerRef.current !== signer) return
          debugError('auth', 'signer ping retry failed', {
            pubkey: shortId(signer.pubkey),
            elapsedMs: debugDuration(startedAt),
            error: errorMessage(error),
          })
          markSignerDisconnected(errorMessage(error))
        }
      } finally {
        const current = signerPingInFlightRef.current
        if (current?.pubkey === signer.pubkey && current.startedAt === startedAt) {
          signerPingInFlightRef.current = null
        }
      }
    }

    void pingSigner()
    const timer = window.setInterval(() => {
      void pingSigner()
    }, 20_000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
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

  useEffect(() => {
    if (relay.mode !== 'live' || appView !== 'group' || !hasSelectedGroup || !canReadGroup) return undefined
    if (roomAccessStatus !== 'open') return undefined
    if (authState === 'connected' || authState === 'connecting' || authState === 'reconnecting') return undefined

    const promptKey = `${snapshot.group.relay}:${snapshot.group.id}:${selfPubkey}`
    if (roomLoginPromptedRef.current === promptKey) return undefined
    roomLoginPromptedRef.current = promptKey

    const timer = window.setTimeout(() => {
      void beginLogin({
        kind: 'manual',
        title: 'Sign in to join the office',
        detail: `Sign in with your Nostr signer to appear in ${metadataName}, move around, and join proximity calls.`,
      })
    }, 500)

    return () => window.clearTimeout(timer)
  }, [
    appView,
    authState,
    beginLogin,
    canReadGroup,
    hasSelectedGroup,
    metadataName,
    relay.mode,
    roomAccessStatus,
    selfPubkey,
    snapshot.group.id,
    snapshot.group.relay,
  ])

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
    appliedSignerRelayRef.current = null
    setActiveSigner(null)
    if (relay.mode === 'live') relay.clearSigner()
    await clearStoredNostrConnectSession()
    setStoredConnectSession(null)
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
    (movement: PositionMovement) => {
      if (!canEnterOfficeRef.current) return
      const sentAt = Date.now()
      lastOwnPositionRef.current = { ...movement, sentAt }
      void relay.publishPosition(selfPubkey, movement, sentAt)
    },
    [relay, selfPubkey],
  )

  const publishOwnPositionEvent = useCallback(() => {
    if (!canEnterOfficeRef.current) return
    const latestPosition = latestPositionsRef.current.find((position) => position.pubkey === selfPubkey) ?? null
    const storedMovement =
      lastOwnPositionRef.current ??
      (latestPosition
        ? {
            startX: latestPosition.x,
            startY: latestPosition.y,
            endX: latestPosition.targetX ?? latestPosition.x,
            endY: latestPosition.targetY ?? latestPosition.y,
            speed: latestPosition.speed ?? 0,
            sentAt: latestPosition.sentAt ?? Date.now(),
          }
        : null)
    if (!storedMovement) return

    lastOwnPositionRef.current = storedMovement
    const { sentAt, ...movement } = storedMovement
    return relay.publishPosition(selfPubkey, movement, sentAt)
  }, [relay, selfPubkey])

  const refreshOwnPositionEvent = useCallback(() => {
    if (!canEnterOfficeRef.current) return
    void Promise.resolve(relay.republishLastPosition(selfPubkey)).then((result) => {
      if (
        result.ok ||
        (result.reason !== 'position-refresh-missing' && result.reason !== 'position-refresh-needs-signature')
      ) {
        return
      }
      if (positionRefreshFallbackInFlightRef.current) return
      positionRefreshFallbackInFlightRef.current = true
      Promise.resolve(publishOwnPositionEvent()).finally(() => {
        positionRefreshFallbackInFlightRef.current = false
      })
    })
  }, [publishOwnPositionEvent, relay, selfPubkey])

  useEffect(() => {
    canEnterOfficeRef.current = canEnterOffice
  }, [canEnterOffice])

  useEffect(() => {
    latestPositionsRef.current = snapshot.positions
  }, [snapshot.positions])

  useEffect(() => {
    positionRefreshRef.current = refreshOwnPositionEvent
  }, [refreshOwnPositionEvent])

  useEffect(() => {
    const ownPosition = snapshot.positions.find((position) => position.pubkey === selfPubkey)
    if (!ownPosition) return
    lastOwnPositionRef.current = {
      startX: ownPosition.startX ?? ownPosition.x,
      startY: ownPosition.startY ?? ownPosition.y,
      endX: ownPosition.targetX ?? ownPosition.x,
      endY: ownPosition.targetY ?? ownPosition.y,
      speed: ownPosition.speed ?? 0,
      sentAt: ownPosition.sentAt ?? Date.now(),
    }
  }, [selfPubkey, snapshot.positions])

  useEffect(() => {
    if (relay.mode !== 'live' || authState !== 'connected' || !canEnterOffice) return undefined

    const refreshPosition = () => positionRefreshRef.current()
    const timer = window.setInterval(refreshPosition, POSITION_REBROADCAST_INTERVAL_MS)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') refreshPosition()
    }
    window.addEventListener('pagehide', refreshPosition)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pagehide', refreshPosition)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [authState, canEnterOffice, relay.mode])

  useEffect(() => {
    if (relay.mode !== 'live' || authState !== 'connected' || !hasSelectedGroup || !canEnterOffice) return
    if (roomAccessStatus !== 'open') return
    if (snapshot.positions.some((position) => position.pubkey === selfPubkey)) return

    const spawnKey = `${snapshot.group.id}:${selfPubkey}`
    if (spawnPublishKeyRef.current === spawnKey) return
    spawnPublishKeyRef.current = spawnKey

    const spawn = spawnForPubkey(officeMap, selfPubkey, snapshot.users.length)
    const spawnMovement = {
      startX: spawn.x,
      startY: spawn.y,
      endX: spawn.x,
      endY: spawn.y,
      speed: 0,
      sentAt: Date.now(),
    }
    lastOwnPositionRef.current = spawnMovement
    const { sentAt, ...movement } = spawnMovement
    void relay.publishPosition(selfPubkey, movement, sentAt).then((result) => {
      if (
        !result.ok &&
        result.reason !== 'position-publish-queued' &&
        result.reason !== 'stale-position-discarded' &&
        result.reason !== 'group-required'
      ) {
        setAuthDetail(`position publish failed: ${result.reason}`)
      }
    })
  }, [
    authState,
    canEnterOffice,
    hasSelectedGroup,
    officeMap,
    relay,
    roomAccessStatus,
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
    setUploadStatus('')

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
        const message = directMessageErrorMessage(result.reason, activeDmPeer?.name ?? nameFor(activeDmPubkey, snapshot.users))
        setUploadStatus(message)
        setAuthStatus(message)
      }
      return
    }

    setDmMessage('')
    setDmFiles([])
    setUploadStatus('')
  }

  function navigateToRelayView(relayUrl = snapshot.group.relay) {
    const normalized = normalizeRelayUrl(relayUrl)
    const url = new URL(window.location.href)
    url.searchParams.set('relay', normalized)
    url.searchParams.delete('c')
    url.searchParams.delete('group')
    url.searchParams.delete('h')
    url.searchParams.delete('view')
    setAppView('relay')
    navigateInApp(url)
  }

  function navigateToDirectMessages() {
    const url = new URL(window.location.href)
    url.searchParams.set('relay', snapshot.group.relay)
    url.searchParams.set('view', 'dm')
    setAppView('dm')
    navigateInApp(url)
  }

  function navigateToGroupView(groupId: string, relayUrl = snapshot.group.relay) {
    const url = new URL(window.location.href)
    url.searchParams.set('c', groupId)
    url.searchParams.set('relay', normalizeRelayUrl(relayUrl))
    url.searchParams.delete('group')
    url.searchParams.delete('h')
    url.searchParams.delete('view')
    setAppView('group')
    navigateInApp(url)
  }

  function switchToRelay(relayUrl: string) {
    const normalized = normalizeRelayUrl(relayUrl)
    const next = uniqueRelayUrls([...storedRelayUrls, normalized])
    setStoredRelayUrls(next)
    writeSavedRelayUrls(next)
    if (sameRelayUrl(normalized, snapshot.group.relay) && appView === 'relay') return
    navigateToRelayView(normalized)
  }

  function addRelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = normalizeRelayUrl(relayUrlInput)
    if (!normalized) return
    setShowAddRelayDialog(false)
    setRelayUrlInput('')
    switchToRelay(normalized)
  }

  function selectRelayGroup(groupId: string, relayUrl = snapshot.group.relay) {
    if (relay.mode === 'mock') {
      relay.selectGroup(groupId)
      setAppView('group')
      return
    }

    if (hasSelectedGroup && groupId === snapshot.group.id && sameRelayUrl(relayUrl, snapshot.group.relay)) {
      navigateToGroupView(groupId, relayUrl)
      return
    }

    navigateToGroupView(groupId, relayUrl)
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
      groupNameHintsRef.current.set(groupNameHintKey(snapshot.group.relay, groupId), groupName)
      if (relay.mode === 'live') {
        await runNip29Action('name chatroom', () =>
          relay.publishEditMetadata(
            selfPubkey,
            {
              name: groupName,
              about: '',
              picture: '',
              private: false,
              restricted: false,
              closed: false,
              hidden: false,
            },
            'metadata updated from nestr',
            groupId,
          ),
        )
      }
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

  function currentCallMediaState(): CallMediaState {
    const hasScreenVideo = Boolean(screenStreamRef.current?.getVideoTracks().some((track) => track.readyState === 'live'))
    const hasCameraVideo = Boolean(
      cameraEnabledRef.current &&
        localStreamRef.current?.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled),
    )
    const hasAudio = Boolean(
      micEnabledRef.current &&
        localStreamRef.current?.getAudioTracks().some((track) => track.readyState === 'live' && track.enabled),
    )
    return {
      audio: hasAudio,
      video: hasScreenVideo || hasCameraVideo,
      screen: hasScreenVideo,
    }
  }

  function liveCallParticipantPubkeys(targetPubkey?: string) {
    return Array.from(
      new Set(
        [
          selfPubkey,
          targetPubkey,
          ...liveCallPeersRef.current.map((peer) => peer.pubkey),
          ...callPeersRef.current.map((peer) => peer.pubkey),
        ].filter((pubkey): pubkey is string => Boolean(pubkey)),
      ),
    )
  }

  function withLocalCallMediaState(payload: unknown, targetPubkey?: string) {
    const participants = liveCallParticipantPubkeys(targetPubkey)
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return {
        ...payload,
        media: currentCallMediaState(),
        participants,
      }
    }

    return {
      value: payload,
      media: currentCallMediaState(),
      participants,
    }
  }

  async function publishLiveCallSignal(kind: number, targetPubkey: string, payload: unknown) {
    if (relay.mode !== 'live') return
    const result = await relay.publishCallSignal(selfPubkey, kind, targetPubkey, withLocalCallMediaState(payload, targetPubkey))
    if (!result.ok && result.reason !== 'throttled') setAuthDetail(`call signal failed: ${result.reason}`)
  }

  function scheduleLiveCallParticipantAnnouncement() {
    if (relay.mode !== 'live' || !callStartedRef.current) return
    if (liveParticipantAnnouncementTimerRef.current !== null) {
      window.clearTimeout(liveParticipantAnnouncementTimerRef.current)
    }
    liveParticipantAnnouncementTimerRef.current = window.setTimeout(() => {
      liveParticipantAnnouncementTimerRef.current = null
      callPeersRef.current.forEach((peer) => {
        void publishLiveCallSignal(OFFICE_KINDS.callRenegotiate, peer.pubkey, {
          reason: 'participants',
        })
      })
    }, 80)
  }

  function publishLiveMediaState() {
    if (relay.mode !== 'live' || !callStartedRef.current) return
    callPeersRef.current.forEach((peer) => {
      void publishLiveCallSignal(OFFICE_KINDS.callRenegotiate, peer.pubkey, {
        reason: 'media-state',
      })
    })
  }

  function liveCallMediaTracks(stream: MediaStream) {
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0]
    return [
      ...stream.getAudioTracks(),
      ...(screenTrack ? [screenTrack] : stream.getVideoTracks()),
    ]
  }

  async function renegotiateLivePeerConnection(peerPubkey: string) {
    const connection = livePeerConnectionsRef.current.get(peerPubkey)
    if (!connection || connection.signalingState !== 'stable') return

    const offer = await connection.createOffer()
    await connection.setLocalDescription(offer)
    await publishLiveCallSignal(OFFICE_KINDS.callOffer, peerPubkey, {
      description: connection.localDescription,
    })
  }

  async function updateLiveVideoSenders(track: MediaStreamTrack | null, sourceStream: MediaStream | null) {
    if (relay.mode !== 'live') return

    await Promise.all(
      Array.from(livePeerConnectionsRef.current.entries()).map(async ([peerPubkey, connection]) => {
        const sender =
          liveVideoSendersRef.current.get(peerPubkey) ??
          connection.getSenders().find((candidate) => candidate.track?.kind === 'video')
        if (sender) {
          liveVideoSendersRef.current.set(peerPubkey, sender)
          await sender.replaceTrack(track)
          return
        }
        if (!track || !sourceStream) return
        liveVideoSendersRef.current.set(peerPubkey, connection.addTrack(track, sourceStream))
        await renegotiateLivePeerConnection(peerPubkey)
      }),
    )
  }

  function remoteDisplayState(pubkey: string, stream: MediaStream) {
    const signaled = remoteMediaStatesRef.current.get(pubkey)
    return {
      hasVideo: signaled?.video === false ? false : remoteStreamHasLiveVideo(stream),
      micMuted: signaled?.audio === undefined ? remoteStreamMicMuted(stream) : !signaled.audio,
    }
  }

  function updateRemoteVideoState(pubkey: string, state: Pick<MockPeerVideo, 'hasVideo' | 'micMuted'>) {
    let changed = false
    const next = remoteVideosRef.current.map((video) => {
      if (video.pubkey !== pubkey) return video
      if (video.hasVideo === state.hasVideo && video.micMuted === state.micMuted) return video
      changed = true
      return { ...video, ...state }
    })
    if (changed) replaceRemoteVideos(next)
  }

  function applyRemoteMediaState(pubkey: string, media: CallMediaState | null) {
    if (!media) return
    remoteMediaStatesRef.current.set(pubkey, media)
    const existing = remoteVideosRef.current.find((video) => video.pubkey === pubkey)
    if (!existing) return
    updateRemoteVideoState(pubkey, remoteDisplayState(pubkey, existing.stream))
  }

  function watchRemoteStream(pubkey: string, stream: MediaStream) {
    const update = () => {
      const existing = remoteVideosRef.current.find((video) => video.pubkey === pubkey)
      if (!existing || existing.stream !== stream) return
      updateRemoteVideoState(pubkey, remoteDisplayState(pubkey, stream))
    }
    const tracks = stream.getTracks()
    tracks.forEach((track) => {
      track.addEventListener('mute', update)
      track.addEventListener('unmute', update)
      track.addEventListener('ended', update)
    })
    const timer = window.setTimeout(update, 0)

    return () => {
      window.clearTimeout(timer)
      tracks.forEach((track) => {
        track.removeEventListener('mute', update)
        track.removeEventListener('unmute', update)
        track.removeEventListener('ended', update)
      })
    }
  }

  function upsertRemoteStream(pubkey: string, name: string, stream: MediaStream) {
    const existing = remoteVideosRef.current.find((video) => video.pubkey === pubkey)
    if (existing?.stream === stream) existing.cleanup?.()
    else if (existing) existing.stop()
    else if (callStartedRef.current) playCallJoinSound()
    const cleanup = watchRemoteStream(pubkey, stream)
    const displayState = remoteDisplayState(pubkey, stream)
    const nextVideo = {
      pubkey,
      name,
      stream,
      ...displayState,
      cleanup,
      stop: () => {
        cleanup()
        stream.getTracks().forEach((track) => track.stop())
      },
    }
    if (existing?.stream === stream) {
      const next = remoteVideosRef.current.map((video) => (video.pubkey === pubkey ? nextVideo : video))
      replaceRemoteVideos(next)
      return
    }
    const next = [
      ...remoteVideosRef.current.filter((video) => video.pubkey !== pubkey),
      nextVideo,
    ]
    replaceRemoteVideos(next)
  }

  function livePeerConnection(peerPubkey: string, peerName: string, stream: MediaStream) {
    const existing = livePeerConnectionsRef.current.get(peerPubkey)
    if (existing) return existing

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    liveCallMediaTracks(stream).forEach((track) => {
      const sourceStream = screenStreamRef.current?.getVideoTracks()[0] === track ? screenStreamRef.current : stream
      const sender = connection.addTrack(track, sourceStream ?? stream)
      if (track.kind === 'video') liveVideoSendersRef.current.set(peerPubkey, sender)
    })
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
      removeLiveCallPeer(peerPubkey)
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
    callStartedRef.current = true
    setCallStarted(true)
    setCameraEnabled(true)
    setMicEnabled(true)
    cameraEnabledRef.current = true
    micEnabledRef.current = true
    return requestLocalMedia(true, true)
  }

  async function startLivePeerConnections(stream: MediaStream | null) {
    if (!stream) return
    await Promise.all(
      callPeersRef.current.map(async (peer) => {
        if (peer.pubkey === selfPubkey) return
        const existingConnection = livePeerConnectionsRef.current.get(peer.pubkey)
        const connection = existingConnection ?? livePeerConnection(peer.pubkey, peer.name, stream)
        if (existingConnection || selfPubkey > peer.pubkey || connection.signalingState !== 'stable') return

        const offer = await connection.createOffer()
        await connection.setLocalDescription(offer)
        await publishLiveCallSignal(OFFICE_KINDS.callOffer, peer.pubkey, {
          description: connection.localDescription,
        })
      }),
    )
  }

  startLivePeerConnectionsRef.current = startLivePeerConnections

  async function handleLiveCallSignal(event: NestrEvent) {
    if (relay.mode !== 'live') return
    if (!isOfficeCallSignalKind(event.kind)) return
    if (event.pubkey === selfPubkey || targetForCallEvent(event) !== selfPubkey) return

    const peerPubkey = event.pubkey
    const peerName = nameFor(peerPubkey, snapshot.users)
    const payload = parseCallSignalPayload(event)
    const participants = callSignalParticipants(payload)
    applyRemoteMediaState(peerPubkey, callSignalMedia(payload))

    if (event.kind === OFFICE_KINDS.callHangup) {
      removeLiveCallPeer(peerPubkey)
      return
    }

    if (event.kind === OFFICE_KINDS.callRenegotiate && !callSignalDescription(payload)) {
      await syncLiveCallParticipants(participants)
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
    addLiveCallPeer(peerPubkey, peerName)
    const stream = await ensureLiveCallMedia()
    if (!stream) return
    const connection = livePeerConnection(peerPubkey, peerName, stream)
    await syncLiveCallParticipants(participants)

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

  function setActiveLiveCallPeers(peers: Array<{ pubkey: string; name: string }>) {
    liveCallPeersRef.current = peers
    setLiveCallPeers(peers)
    callPeersRef.current = relay.mode === 'live' && callStartedRef.current ? peers : callPeersRef.current
  }

  function addLiveCallPeer(pubkey: string, name: string) {
    if (relay.mode !== 'live') return
    const existing = liveCallPeersRef.current.find((peer) => peer.pubkey === pubkey)
    const next = existing
      ? liveCallPeersRef.current.map((peer) => (peer.pubkey === pubkey ? { pubkey, name } : peer))
      : [...liveCallPeersRef.current, { pubkey, name }]
    setActiveLiveCallPeers(next)
    if (!existing) scheduleLiveCallParticipantAnnouncement()
  }

  async function syncLiveCallParticipants(participants: string[]) {
    if (relay.mode !== 'live' || !callStartedRef.current) return
    const nextByPubkey = new Map(liveCallPeersRef.current.map((peer) => [peer.pubkey, peer]))
    let changed = false

    participants.forEach((pubkey) => {
      if (!pubkey || pubkey === selfPubkey) return
      const name = nameFor(pubkey, snapshot.users)
      const existing = nextByPubkey.get(pubkey)
      if (existing?.name === name) return
      nextByPubkey.set(pubkey, { pubkey, name })
      changed = true
    })

    if (!changed) return
    setActiveLiveCallPeers(Array.from(nextByPubkey.values()))
    if (localStreamRef.current) await startLivePeerConnectionsRef.current(localStreamRef.current)
  }

  function cleanupLivePeer(pubkey: string) {
    livePeerConnectionsRef.current.get(pubkey)?.close()
    livePeerConnectionsRef.current.delete(pubkey)
    liveVideoSendersRef.current.delete(pubkey)
    pendingIceCandidatesRef.current.delete(pubkey)
    remoteVideosRef.current.find((video) => video.pubkey === pubkey)?.stop()
    remoteMediaStatesRef.current.delete(pubkey)
    remoteVideosRef.current = remoteVideosRef.current.filter((video) => video.pubkey !== pubkey)
    setRemoteVideos(remoteVideosRef.current)
  }

  function finishCallLocally() {
    callStartedRef.current = false
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    stopLivePeerConnections()
    clearRemoteVideos()
    setLocalStream(null)
    setScreenStream(null)
    localStreamRef.current = null
    screenStreamRef.current = null
    setActiveLiveCallPeers([])
    setCallStarted(false)
    setCallExpanded(false)
    setMediaState('idle')
  }

  function removeLiveCallPeer(pubkey: string) {
    cleanupLivePeer(pubkey)
    const next = liveCallPeersRef.current.filter((peer) => peer.pubkey !== pubkey)
    setActiveLiveCallPeers(next)
    if (relay.mode === 'live' && callStartedRef.current && next.length === 0) {
      finishCallLocally()
    } else {
      scheduleLiveCallParticipantAnnouncement()
    }
  }

  function clearRemoteVideos() {
    remoteVideosRef.current.forEach((video) => video.stop())
    remoteVideosRef.current = []
    remoteMediaStatesRef.current.clear()
    setRemoteVideos([])
  }

  function stopLivePeerConnections(notifyPeers = false) {
    if (liveParticipantAnnouncementTimerRef.current !== null) {
      window.clearTimeout(liveParticipantAnnouncementTimerRef.current)
      liveParticipantAnnouncementTimerRef.current = null
    }
    if (notifyPeers && relay.mode === 'live') {
      callPeersRef.current.forEach((peer) => {
        void publishLiveCallSignal(OFFICE_KINDS.callHangup, peer.pubkey, { reason: 'hangup' })
      })
    }
    livePeerConnectionsRef.current.forEach((connection) => connection.close())
    livePeerConnectionsRef.current.clear()
    liveVideoSendersRef.current.clear()
    pendingIceCandidatesRef.current.clear()
  }

  function stopRemoteVideos() {
    stopLivePeerConnections()
    clearRemoteVideos()
    setActiveLiveCallPeers([])
  }

  function stopScreenShare() {
    const currentScreenStream = screenStreamRef.current ?? screenStream
    const nextVideoTrack = cameraEnabledRef.current ? localStreamRef.current?.getVideoTracks()[0] ?? null : null
    void updateLiveVideoSenders(nextVideoTrack, localStreamRef.current)
    currentScreenStream?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current = null
    setScreenStream(null)
    window.setTimeout(publishLiveMediaState, 0)
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
      callStartedRef.current = false
      stopLivePeerConnections(true)
      finishCallLocally()
      return
    }

    setMediaState('requesting')
    setCameraEnabled(true)
    setMicEnabled(true)
    cameraEnabledRef.current = true
    micEnabledRef.current = true
    if (relay.mode === 'live') {
      setActiveLiveCallPeers(callPeers)
      callPeersRef.current = callPeers
    } else {
      setActiveLiveCallPeers([])
    }
    callStartedRef.current = true
    setCallStarted(true)
    const stream = await requestLocalMedia(true, true)
    if (relay.mode === 'mock') {
      replaceRemoteVideos(reconcileMockVideos(callPeerKey))
      return
    }
    clearRemoteVideos()
    await startLivePeerConnections(stream)
  }

  async function toggleCamera() {
    const nextCamera = !cameraEnabled
    setCameraEnabled(nextCamera)
    cameraEnabledRef.current = nextCamera
    if (localStream?.getVideoTracks().length) {
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = nextCamera
      })
      if (!screenStreamRef.current) {
        await updateLiveVideoSenders(nextCamera ? localStream.getVideoTracks()[0] ?? null : null, localStream)
      }
      publishLiveMediaState()
      if (!nextCamera) return
    }
    const stream = await requestLocalMedia(nextCamera, micEnabled)
    if (!screenStreamRef.current) {
      await updateLiveVideoSenders(nextCamera ? stream?.getVideoTracks()[0] ?? null : null, stream)
    }
    publishLiveMediaState()
  }

  async function toggleMic() {
    const nextMic = !micEnabled
    setMicEnabled(nextMic)
    micEnabledRef.current = nextMic
    if (localStream?.getAudioTracks().length) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = nextMic
      })
      publishLiveMediaState()
      return
    }
    await requestLocalMedia(cameraEnabled, nextMic)
    publishLiveMediaState()
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
      stream.getVideoTracks()[0]?.addEventListener('ended', stopScreenShare, { once: true })
      screenStreamRef.current = stream
      setScreenStream(stream)
      await updateLiveVideoSenders(stream.getVideoTracks()[0] ?? null, stream)
      publishLiveMediaState()
    } catch {
      screenStreamRef.current = null
      setScreenStream(null)
      publishLiveMediaState()
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
              <a className="connect-card qr-action" href={connectSession.uri} aria-label="Open Nostr Connect">
                <img src={nostrConnectQr} alt="Nostr Connect QR" />
              </a>
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

      {signerPendingPrompt && (
        <section className="signer-pending-overlay" role="dialog" aria-modal="true" aria-label="Signer pending">
          <div className="signer-pending-modal">
            <LoaderCircle size={30} className="spin-icon" />
            <div>
              <p className="eyebrow">waiting for approval</p>
              <h2>Signer pending</h2>
              <p>
                Nestr is waiting for {signerPendingPrompt.signerLabel} to sign a{' '}
                {signerEventDescription(signerPendingPrompt.eventKind)} event. Some signers ask you to approve each
                event kind the first time, including call signaling and office presence.
              </p>
              <span>Event kind {signerPendingPrompt.eventKind}</span>
            </div>
          </div>
        </section>
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

            {relay.mode === 'live' && (
              <section className="account-info-card">
                <div className="section-title">
                  <span>Nostr Connect</span>
                  <span>{accountSignerRelays.length}</span>
                </div>
                {accountSignerRelays.length > 0 ? (
                  accountSignerRelays.map((relayUrl) => <code key={relayUrl}>{relayUrl}</code>)
                ) : (
                  <code>{activeSigner?.label === 'NIP-07' ? 'browser signer' : 'no relay hint stored'}</code>
                )}
              </section>
            )}

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

      <Dialog open={showAddRelayDialog} onOpenChange={setShowAddRelayDialog}>
        <DialogContent className="auth-modal create-chatroom-modal">
          <DialogHeader className="auth-modal-header">
            <div>
              <p className="eyebrow">NIP-29</p>
              <DialogTitle>Add Relay</DialogTitle>
            </div>
          </DialogHeader>
          <DialogDescription className="auth-modal-copy">
            Add a NIP-29 relay to the rail. Nestr will discover its chatrooms from kind 39000 metadata.
          </DialogDescription>
          <form className="admin-form" onSubmit={addRelay}>
            <Input
              value={relayUrlInput}
              onChange={(event) => setRelayUrlInput(event.target.value)}
              placeholder="wss://relay.example"
              aria-label="Relay URL"
              spellCheck={false}
            />
            <div className="auth-actions">
              <Button type="button" className="secondary-action" onClick={() => setShowAddRelayDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" className="primary-action">
                <Radio size={16} />
                Add
              </Button>
            </div>
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
                  placeholder="Message to moderators (optional)"
                  aria-label="Optional message to moderators"
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
                    : 'The message and invite code are both optional. The relay decides how moderators see join requests.'}
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
            navigateToDirectMessages()
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
        {savedRelayUrls.map((relayUrl) => {
          const activeRelay = sameRelayUrl(relayUrl, snapshot.group.relay)
          return (
            <RelayRailButton
              key={relayUrl}
              relayUrl={relayUrl}
              active={activeRelay}
              onClick={() => {
                if (activeRelay) navigateToRelayView(relayUrl)
                else switchToRelay(relayUrl)
              }}
            />
          )
        })}
        <Button
          type="button"
          className="rail-button relay add"
          onClick={() => setShowAddRelayDialog(true)}
          aria-label="Add relay"
          title="Add relay"
        >
          <Plus size={22} />
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
        } ${appView === 'group' && mobileDetailsOpen ? 'mobile-open' : ''}`}
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
                  const groupRelayUrl = relayUrlFromGroupEvent(groupEvent, snapshot.group.relay)
                  const groupHost = relayHostLabel(groupRelayUrl)
                  const currentGroup = hasSelectedGroup && groupId === snapshot.group.id && sameRelayUrl(groupRelayUrl, snapshot.group.relay)

                  return (
                    <Button
                      type="button"
                      key={`${groupRelayUrl}:${groupEvent.pubkey}:${groupId}`}
                      className={`relay-nav-row ${currentGroup ? 'active' : ''}`}
                      onClick={() => selectRelayGroup(groupId, groupRelayUrl)}
                      title={groupHost}
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
          <Button
            type="button"
            className="mobile-details-toggle"
            onClick={() => setMobileDetailsOpen((open) => !open)}
            aria-label={mobileDetailsOpen ? 'Collapse group details' : 'Expand group details'}
          >
            {mobileDetailsOpen ? <ChevronLeft size={16} /> : <Info size={16} />}
          </Button>
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
          {renderedPeople.map((user) => (
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
          {hiddenPeopleCount > 0 && (
            <Button
              type="button"
              className="secondary-action members-more"
              onClick={() =>
                setPeopleRenderState((current) => ({
                  key: peopleListKey,
                  limit: (current.key === peopleListKey ? current.limit : PEOPLE_RENDER_STEP) + PEOPLE_RENDER_STEP,
                }))
              }
            >
              Show {Math.min(PEOPLE_RENDER_STEP, hiddenPeopleCount)} more
            </Button>
          )}
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
            <div className="office-count-chip" aria-label={officePresenceLabel}>
              {officePresenceLabel}
            </div>
            <Button
              type="button"
              className="office-chat-toggle"
              onClick={() => setMobileChatOpen((open) => !open)}
              aria-label={mobileChatOpen ? 'Close chat' : `Open chat${unreadChatCount ? `, ${unreadChatCount} unread` : ''}`}
            >
              <MessageCircle size={18} />
              {unreadChatCount > 0 && <span>{unreadChatCount > 99 ? '99+' : unreadChatCount}</span>}
            </Button>
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
                  <strong>Want to say hello? Join the group!</strong>
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
                  </Button>
                  <Button
                    type="button"
                    className={micEnabled ? '' : 'off'}
                    onClick={toggleMic}
                    aria-label={micEnabled ? 'Mute microphone' : 'Enable microphone'}
                  >
                    {micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
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
                  </Button>
                  <Button
                    type="button"
                    className="hangup"
                    onClick={toggleCall}
                    aria-label="Hang up"
                  >
                    <PhoneOff size={18} />
                  </Button>
                </div>
                <div className="stream-grid">
                  <StreamTile
                    label={currentUser?.name ?? 'You'}
                    stream={localCallStream}
                    muted
                    micMuted={!micEnabled}
                    status={screenStream ? 'screen' : 'local'}
                  />
                  {remoteVideos.map((video) => (
                    <StreamTile
                      key={video.pubkey}
                      label={video.name}
                      stream={video.stream}
                      showVideo={video.hasVideo ?? true}
                      micMuted={video.micMuted ?? false}
                    />
                  ))}
                  {relay.mode === 'live' &&
                    displayedCallPeers
                      .filter((peer) => !remoteVideoPubkeys.has(peer.pubkey))
                      .map((peer) => (
                        <StreamTile
                          key={`pending-${peer.pubkey}`}
                          label={peer.name}
                          sublabel="connecting"
                          stream={null}
                          micMuted
                        />
                      ))}
                </div>
              </section>
            )}
          </section>

          <aside className={`side-panel chat-panel ${mobileChatOpen ? 'mobile-open' : ''}`} aria-label="Chat">
            <div className="chat-header">
              <div>
                <h2>Chat</h2>
              </div>
              <Button
                type="button"
                className="chat-close"
                onClick={() => setMobileChatOpen(false)}
                aria-label="Close chat"
              >
                <X size={16} />
              </Button>
              <MessageCircle className="chat-header-icon" size={22} />
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

            {canWriteGroupChat ? (
              <form className="composer" onSubmit={sendMessage}>
                <Label htmlFor="message">Message</Label>
                <SelectedFiles files={messageFiles} onRemove={removeMessageFile} />
                <div className="input-row">
                  <Input
                    id="message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Write to the room"
                  />
                  <Label className="file-picker" aria-label="Attach files">
                    <Paperclip size={17} />
                    <input
                      type="file"
                      multiple
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? [])
                        setMessageFiles((current) => [...current, ...files])
                        event.currentTarget.value = ''
                      }}
                    />
                  </Label>
                  <Button type="submit" aria-label="Send message">
                    {uploadStatus ? <LoaderCircle size={18} className="spin-icon" /> : <Send size={18} />}
                  </Button>
                </div>
                {uploadStatus && <span className="upload-status">{uploadStatus}</span>}
              </form>
            ) : (
              <div className="composer composer-read-only" role="note">
                <span>Only members can send messages</span>
                <Button type="button" className="link-button" onClick={() => setAdminDialog('join')}>
                  Join
                </Button>
              </div>
            )}
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
            <div className="relay-toolbar-actions">
              <Button type="button" className="secondary-action" onClick={() => setShowAddRelayDialog(true)}>
                <Plus size={16} />
                Relay
              </Button>
              {canCreateRelayGroup && (
                <Button type="button" className="primary-action" onClick={() => setShowCreateGroupDialog(true)}>
                  <MessageCircle size={16} />
                  Create
                </Button>
              )}
            </div>
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
                const groupRelayUrl = relayUrlFromGroupEvent(groupEvent, snapshot.group.relay)
                const groupHost = relayHostLabel(groupRelayUrl)
                const currentGroup = hasSelectedGroup && groupId === snapshot.group.id && sameRelayUrl(groupRelayUrl, snapshot.group.relay)

                return (
                  <Button
                    type="button"
                    key={`${groupRelayUrl}:${groupEvent.pubkey}:${groupId}`}
                    className={`relay-chat-card ${currentGroup ? 'current' : ''}`}
                    onClick={() => selectRelayGroup(groupId, groupRelayUrl)}
                  >
                    <span className="relay-chat-hash">#</span>
                    <span>
                      <strong>{name}</strong>
                      <small>{sameRelayUrl(groupRelayUrl, snapshot.group.relay) ? about : `${about} · ${groupHost}`}</small>
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
              navigateInApp('/?relay=relay.nestr.development')
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
                onClick={handleInternalLink}
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
            <a className="relay-chat-card landing-relay-card" href="/?relay=groups.0xchat.com" onClick={handleInternalLink}>
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
  const [launch, setLaunch] = useState(() => parseLaunch())

  useEffect(() => {
    const syncLaunch = () => setLaunch(parseLaunch())
    window.addEventListener('popstate', syncLaunch)
    return () => window.removeEventListener('popstate', syncLaunch)
  }, [])

  if (launch.mode === 'landing') return <LandingApp />
  return <OfficeApp key={launchKey(launch)} launch={launch} />
}

export default App
