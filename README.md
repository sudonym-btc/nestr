# nestr

Nestr is a small NIP-29 spatial-office prototype for Nostr users. Any relay-based group can become an office: group metadata drives the room, NIP-29 chat stays available as the global sidebar, and ephemeral office presence renders avatars in a deterministic shared map.

## What is in this prototype

- React + TypeScript app shell
- Phaser-powered walkable office canvas
- Infinite viewport-driven office generation with 2.5D rooms and furniture
- Mock relay that simulates NIP-29 group metadata, members, roles, and global chat
- Live NIP-29 launch mode from `?c=<group-id>&relay=<relay-host>`
- NIP-07 browser signer and NIP-46/Nostr Connect login paths
- NIP-42 relay authentication after signer connect, with live refetch
- Origin-bound encrypted IndexedDB storage for restored Nostr Connect sessions
- Ephemeral `kind:25029` avatar movement events with client-side presence state
- Tweened remote avatar movement
- Deterministic avatars derived from each user's npub/pubkey
- P2P WebRTC mesh pressure estimator for proximity calls
- Mock WebRTC call grid with generated remote peer video streams and fullscreen mode
- Vitest logic coverage and a Playwright smoke test with screenshot output

## Scripts

```bash
npm run dev
npm run build
npm test
npm run lint
npm run e2e
```

## NIP-29 model

The mock relay emits relay-signed NIP-29-shaped records:

- `kind:39000` group metadata with `d` tag
- `kind:39001` admins
- `kind:39002` members
- `kind:39003` roles
- `kind:1` group chat with `h` tag
- `kind:25029` ephemeral avatar position with `h` tag

The map seed is derived from the group id, so every client can render the same office from the same group state.

## Live launch mode

By default, Nestr runs against the local mock relay. Add NIP-29 group params to switch into live mode:

```text
http://localhost:5173/?c=0bdfff7a01de485de1343b83ec11b0d66d92e4d75e8c5851a05dab288be4f0aa&relay=groups.0xchat.com
```

Live mode normalizes bare relay hosts to `wss://`, subscribes to the group's `kind:39000-39003` metadata and `h`-tagged group timeline, and publishes signed `kind:9` chat plus ephemeral `kind:25029` movement after the user connects a signer. Once a signer is available it performs NIP-42 relay auth when the relay has provided a challenge, then resubscribes to fetch restricted group state. NIP-46 session material is encrypted with a non-extractable WebCrypto key stored in IndexedDB and retried on startup. The app never asks for an `nsec`.

NIP-29 itself does not define an online/live presence field. Nestr treats recent `kind:25029` position events as its office presence extension while preserving NIP-29 membership and roles from the relay.
