import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import * as QRCode from 'qrcode'
import {
  Camera,
  CameraOff,
  KeyRound,
  LockKeyhole,
  LogIn,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  QrCode,
  Minimize2,
  Radio,
  Send,
  Users,
  Video,
} from 'lucide-react'
import './App.css'
import { PhaserOffice } from './game/PhaserOffice'
import { avatarCss, npubForPubkey, seededPubkey, shortNpub } from './lib/avatar'
import { parseLaunch } from './lib/launch'
import { createLiveRelay } from './lib/liveRelay'
import { createMockRelay, type MockUser, type RelaySnapshot } from './lib/mockRelay'
import { hasTag, tagValue, type NestrSigner } from './lib/nostr'
import { createMockPeerVideo, type MockPeerVideo } from './lib/mockVideo'
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

interface StreamTileProps {
  label: string
  sublabel: string
  stream: MediaStream | null
  muted?: boolean
}

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
  const [authBusy, setAuthBusy] = useState(false)
  const [authStatus, setAuthStatus] = useState(() =>
    launch.mode === 'live' ? 'opening live NIP-29 room' : 'local mock relay',
  )
  const [connectSession, setConnectSession] = useState<NostrConnectSession | null>(null)
  const [nostrConnectQr, setNostrConnectQr] = useState<string | null>(null)
  const callStageRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const autoAuthAttemptedRef = useRef(false)
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
  const connectionMessage = snapshot.connectionMessage ?? authStatus
  const currentUser = snapshot.users.find((user) => user.pubkey === selfPubkey)
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

  const applySigner = useCallback(
    async (signer: NestrSigner) => {
      if (relay.mode !== 'live') return

      const spawn = spawnForPubkey(officeMap, signer.pubkey, snapshot.users.length)
      await relay.setSigner(signer)
      setSelfPubkey(signer.pubkey)
      setNpubInput(npubForPubkey(signer.pubkey))
      setCallStarted(false)
      stopRemoteVideos()
      setCallExpanded(false)
      setNostrConnectQr(null)
      setConnectSession(null)
      setAuthStatus(`${signer.label} connected as ${shortNpub(signer.pubkey)}`)

      const result = await relay.publishPosition(signer.pubkey, spawn.x, spawn.y, 0, 0)
      if (!result.ok && result.reason !== 'throttled') {
        setAuthStatus(`${signer.label} connected; position publish failed: ${result.reason}`)
      }
    },
    [officeMap, relay, snapshot.users.length],
  )

  const connectBrowserSigner = useCallback(
    async (isAutoAttempt = false) => {
      if (relay.mode !== 'live') return

      setAuthBusy(true)
      setAuthStatus(isAutoAttempt ? 'asking NIP-07 signer' : 'opening NIP-07 signer')
      try {
        const signer = await connectNip07Signer()
        await applySigner(signer)
      } catch (error) {
        setAuthStatus(errorMessage(error))
      } finally {
        setAuthBusy(false)
      }
    },
    [applySigner, relay],
  )

  const connectRemoteSigner = useCallback(async () => {
    if (relay.mode !== 'live') return

    connectSession?.abort()
    setAuthBusy(true)
    setAuthStatus('waiting for Nostr Connect signer')

    const session = startNostrConnect(relay.relayUrl)
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

    try {
      const result = await session.waitForSigner
      await writeStoredNostrConnectSession(result.storedSession)
      await applySigner(result.signer)
    } catch (error) {
      setAuthStatus(errorMessage(error))
    } finally {
      setAuthBusy(false)
    }
  }, [applySigner, connectSession, relay])

  const beginAutoAuth = useCallback(async () => {
    if (relay.mode !== 'live') return

    const storedSession = await readStoredNostrConnectSession()
    if (storedSession) {
      setAuthBusy(true)
      setAuthStatus('restoring Nostr Connect session')
      try {
        const signer = await restoreNostrConnectSigner(storedSession)
        await applySigner(signer)
        setAuthStatus(`NIP-46 restored as ${shortNpub(signer.pubkey)}`)
        return
      } catch (error) {
        await clearStoredNostrConnectSession()
        setAuthStatus(`saved signer unavailable: ${errorMessage(error)}`)
      } finally {
        setAuthBusy(false)
      }
    }

    if (window.nostr) {
      await connectBrowserSigner(true)
      return
    }

    await connectRemoteSigner()
  }, [applySigner, connectBrowserSigner, connectRemoteSigner, relay])

  useEffect(() => {
    return () => connectSession?.abort()
  }, [connectSession])

  useEffect(() => {
    if (relay.mode !== 'live' || autoAuthAttemptedRef.current) return

    const timer = window.setTimeout(() => {
      if (autoAuthAttemptedRef.current) return

      autoAuthAttemptedRef.current = true
      void beginAutoAuth()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [beginAutoAuth, relay])

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
    <main className="app-shell">
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
            {snapshot.users.length} members
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
            <div className="auth-actions">
              <button
                type="button"
                className="secondary-action"
                disabled={authBusy}
                onClick={() => void connectBrowserSigner(false)}
              >
                <KeyRound size={17} />
                NIP-07
              </button>
              <button
                type="button"
                className="secondary-action"
                disabled={authBusy}
                onClick={() => void connectRemoteSigner()}
              >
                <QrCode size={17} />
                Nostr Connect
              </button>
            </div>
            {connectSession && (
              <div className="connect-card">
                {nostrConnectQr && <img src={nostrConnectQr} alt="Nostr Connect QR" />}
                <a href={connectSession.uri}>Open Nostr Connect</a>
                <textarea readOnly value={connectSession.uri} aria-label="Nostr Connect URI" />
              </div>
            )}
          </section>
        )}

        <section className="panel-section">
          <div className="section-title">
            <span>Nearby mesh</span>
            <span className={`mesh-pill ${health}`}>{mesh.participants}</span>
          </div>
          <div className="mesh-card">
            <div>
              <strong>{callStarted ? 'P2P live' : nearby.length ? 'P2P ready' : 'Idle'}</strong>
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
            {nearby.length === 0 && <span>Open space</span>}
          </div>
          {callStarted && <p className="call-note">{remoteVideos.length} mock peers streaming test video</p>}
        </section>

        <section className="panel-section people-list">
          <div className="section-title">
            <span>Members</span>
            <span>{mapCapacityLabel(activeCount)}</span>
          </div>
          {snapshot.users.map((user) => (
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
        <div className="world-topbar">
          <div>
            <span className="eyebrow">NIP-29 group</span>
            <strong>{snapshot.group.id}</strong>
          </div>
          <div className="topbar-meta">
            <span>{snapshot.group.relay}</span>
            <span>{officeMap.infinite ? 'infinite' : `${officeMap.cols}x${officeMap.rows}`}</span>
          </div>
        </div>
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
                </div>
                <p>{event.content}</p>
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
