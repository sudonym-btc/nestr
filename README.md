# nestr

Nestr is a small NIP-29 spatial-office prototype for Nostr users. Any relay-based group can become an office: group metadata drives the room, NIP-29 chat stays available as the global sidebar, and ephemeral office presence renders avatars in a deterministic shared map.

## What is in this prototype

- React + TypeScript app shell
- Phaser-powered walkable office canvas
- Mock relay that simulates NIP-29 group metadata, members, roles, and global chat
- Ephemeral `kind:25029` avatar movement events with client-side presence state
- Deterministic avatars derived from each user's npub/pubkey
- P2P WebRTC mesh pressure estimator for proximity calls
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
