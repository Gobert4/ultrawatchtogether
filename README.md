# UltraWatchTogether (prototype)

A minimal, self-hosted *watch-together* proof-of-concept:
- Host shares a desktop/window/tab via **WebRTC**
- Viewers join by link and watch with low latency
- Text chat included

## Requirements
- Node.js 18+ (recommended)
- A modern desktop browser (Chrome/Edge/Firefox)

## Run locally
```bash
npm install
npm start
```

Then open:
- Host: `http://localhost:3000` -> **Create room** -> **Start sharing**
- Viewer: open the invite link (shown to the host) or visit `http://localhost:3000/?room=<ROOMID>` and click **Join**

## Notes / Known limitations (expected for POC)
- This uses *mesh*: host creates 1 WebRTC connection per viewer.
  - Works great for small groups.
  - For larger groups, you'll want an SFU (mediasoup/livekit/jitsi) so the host uploads only one stream.
- Connectivity across the public internet can fail for some NAT types without TURN.
  - Add a TURN server (coturn) and put it into `iceServers` in `public/client.js`.

## Roadmap
- TURN configuration UI
- Better stats (bitrate / fps / latency)
- Optional SFU mode
- Room password / whitelist access
