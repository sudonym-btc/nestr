import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  LockKeyhole,
  LogIn,
  MessageCircle,
  Mic,
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
import { estimateWebRtcMesh, meshHealth, nearbyPeers } from './lib/videoMesh'
import { buildOfficeMap, mapCapacityLabel } from './lib/world'

function nameFor(pubkey: string, users: MockUser[]) {
  return users.find((user) => user.pubkey === pubkey)?.name ?? shortNpub(pubkey)
}

function groupTagLabel(snapshot: RelaySnapshot, tag: string) {
  return hasTag(snapshot.group.metadata, tag) ? tag : `open ${tag}`
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
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

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

  useEffect(() => relay.subscribe((next) => setSnapshot(next)), [relay])

  useEffect(() => {
    const timer = window.setInterval(() => {
      relay.tickBots(selfPubkey, officeMap)
    }, 900)

    return () => window.clearInterval(timer)
  }, [officeMap, relay, selfPubkey])

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

  useEffect(() => {
    return () => {
      localStream?.getTracks().forEach((track) => track.stop())
    }
  }, [localStream])

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
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault()
    relay.publishGroupMessage(selfPubkey, message)
    setMessage('')
  }

  async function toggleCall() {
    if (callStarted) {
      localStream?.getTracks().forEach((track) => track.stop())
      setLocalStream(null)
      setCallStarted(false)
      setMediaState('idle')
      return
    }

    setMediaState('requesting')
    setCallStarted(true)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
        },
      })
      setLocalStream(stream)
      setMediaState('live')
    } catch {
      setMediaState('blocked')
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
              <p>{mesh.connections} links · {mesh.estimatedUploadMbps} Mbps uplink</p>
            </div>
            <button
              type="button"
              className="primary-action"
              disabled={nearby.length === 0}
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
          {callStarted && (
            <div className="video-dock" data-state={mediaState}>
              <video ref={localVideoRef} autoPlay muted playsInline />
              <div className="video-copy">
                <strong>{mediaState === 'live' ? 'Local camera' : 'Media pending'}</strong>
                <span>{mediaState === 'blocked' ? 'Permission blocked' : `${mesh.participants} peer mesh`}</span>
              </div>
            </div>
          )}
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
            <span>{officeMap.cols}x{officeMap.rows}</span>
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
