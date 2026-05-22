import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Camera,
  CameraOff,
  LockKeyhole,
  LogIn,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  Radio,
  Send,
  Users,
  Video,
} from 'lucide-react'
import './App.css'
import { PhaserOffice } from './game/PhaserOffice'
import { avatarCss, npubForPubkey, shortNpub } from './lib/avatar'
import { createMockRelay, type MockUser, type RelaySnapshot } from './lib/mockRelay'
import { hasTag, tagValue } from './lib/nostr'
import { createMockPeerVideo, type MockPeerVideo } from './lib/mockVideo'
import { estimateWebRtcMesh, meshHealth, nearbyPeers } from './lib/videoMesh'
import { buildOfficeMap, mapCapacityLabel } from './lib/world'

function nameFor(pubkey: string, users: MockUser[]) {
  return users.find((user) => user.pubkey === pubkey)?.name ?? shortNpub(pubkey)
}

function groupTagLabel(snapshot: RelaySnapshot, tag: string) {
  return hasTag(snapshot.group.metadata, tag) ? tag : `open ${tag}`
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
  const relay = useMemo(() => createMockRelay(), [])
  const [snapshot, setSnapshot] = useState(() => relay.snapshot())
  const [selfPubkey, setSelfPubkey] = useState(() => snapshot.users[0].pubkey)
  const [npubInput, setNpubInput] = useState<string>(() => npubForPubkey(snapshot.users[0].pubkey))
  const [message, setMessage] = useState('')
  const [callStarted, setCallStarted] = useState(false)
  const [mediaState, setMediaState] = useState<'idle' | 'requesting' | 'live' | 'blocked'>('idle')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteVideos, setRemoteVideos] = useState<MockPeerVideo[]>([])
  const [cameraEnabled, setCameraEnabled] = useState(true)
  const [micEnabled, setMicEnabled] = useState(true)
  const [callExpanded, setCallExpanded] = useState(false)
  const callStageRef = useRef<HTMLDivElement | null>(null)
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

  useEffect(() => relay.subscribe((next) => setSnapshot(next)), [relay])

  useEffect(() => {
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

  function sendMessage(event: FormEvent) {
    event.preventDefault()
    relay.publishGroupMessage(selfPubkey, message)
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
          <span className="relay-dot" />
        </div>

        <p className="about">{groupAbout}</p>

        <div className="status-grid">
          <span>
            <LockKeyhole size={15} />
            {groupTagLabel(snapshot, 'restricted')}
          </span>
          <span>
            <Users size={15} />
            {snapshot.users.length} members
          </span>
          <span>
            <Radio size={15} />
            {snapshot.eventCount} events
          </span>
          <span>
            <MessageCircle size={15} />
            {snapshot.group.id}
          </span>
        </div>

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
              onClick={() => {
                setSelfPubkey(user.pubkey)
                setNpubInput(user.npub)
                setCallStarted(false)
                stopRemoteVideos()
                setCallExpanded(false)
              }}
            >
              <span className="avatar-chip" style={avatarCss(user.pubkey)} />
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
            aria-label="Mock WebRTC call"
          >
            <div className="call-stage-bar">
              <div>
                <strong>Mock WebRTC mesh</strong>
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
            <h2>NIP-29 chat</h2>
          </div>
          <MessageCircle size={22} />
        </div>

        <div className="messages" role="log" aria-label="Messages">
          {snapshot.messages.map((event) => (
            <article key={event.id} className="message">
              <div className="message-meta">
                <span className="avatar-chip small" style={avatarCss(event.pubkey)} />
                <strong>{nameFor(event.pubkey, snapshot.users)}</strong>
                <time>{new Date(event.created_at * 1000).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}</time>
              </div>
              <p>{event.content}</p>
            </article>
          ))}
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
