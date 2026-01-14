/*
  UltraWatchTogether - minimal signaling + room server

  Features
  - Host creates a room and starts screen share.
  - Viewers join via a link and receive a low-latency WebRTC stream.
  - Text chat via the same WebSocket signaling channel.

  Notes
  - Media never touches this server; it is sent over WebRTC between peers.
  - This implementation uses a mesh: the host keeps one RTCPeerConnection per viewer.
    For larger rooms you’ll eventually want an SFU (mediasoup/livekit/jitsi, etc.).
*/

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

// Create new room id (handy for host)
app.get("/api/new-room", (_req, res) => {
  // short, shareable room id
  const roomId = uuidv4().split("-")[0];
  res.json({ roomId });
});

/** @type {Map<string, {
 *   roomId: string,
 *   hostId: string | null,
 *   clients: Map<string, import('ws').WebSocket>,
 *   roles: Map<string, 'host'|'viewer'>,
 *   names: Map<string, string>,
 *   createdAt: number
 * }>}
 */
const rooms = new Map();

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const ws of room.clients.values()) safeSend(ws, obj);
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function ensureRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      roomId,
      hostId: null,
      clients: new Map(),
      roles: new Map(),
      names: new Map(),
      createdAt: Date.now(),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function deleteRoom(roomId) {
  rooms.delete(roomId);
}

function roster(room) {
  const viewers = [];
  for (const [id, role] of room.roles.entries()) {
    if (role === "viewer") viewers.push({ id, name: room.names.get(id) || "Viewer" });
  }
  const host = room.hostId ? { id: room.hostId, name: room.names.get(room.hostId) || "Host" } : null;
  return { host, viewers };
}

// Keepalive (optional but helps with some proxies)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const clientId = uuidv4();
  ws.clientId = clientId;
  ws.roomId = null;
  ws.role = null;

  safeSend(ws, { type: "hello", id: clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return safeSend(ws, { type: "error", message: "Invalid JSON" });
    }

    const type = msg.type;

    if (type === "join") {
      const roomId = String(msg.roomId || "").trim();
      const role = msg.role === "host" ? "host" : "viewer";
      const name = String(msg.name || "").trim().slice(0, 40) || (role === "host" ? "Host" : "Viewer");

      if (!roomId) return safeSend(ws, { type: "error", message: "Missing roomId" });

      const room = ensureRoom(roomId);

      // Join room
      room.clients.set(clientId, ws);
      room.roles.set(clientId, role);
      room.names.set(clientId, name);

      ws.roomId = roomId;
      ws.role = role;

      if (role === "host") {
        // If an existing host exists, replace it (new host takes over)
        room.hostId = clientId;

        safeSend(ws, { type: "joined", roomId, id: clientId, role, roster: roster(room) });
        broadcast(room, { type: "system", message: `${name} is hosting room ${roomId}` });

        // Let existing viewers know host is ready
        for (const [id, r] of room.roles.entries()) {
          if (r === "viewer" && id !== clientId) {
            const vws = room.clients.get(id);
            safeSend(vws, { type: "host_ready", hostId: clientId });
          }
        }

      } else {
        // viewer
        if (!room.hostId || !room.clients.get(room.hostId)) {
          // No host online
          room.clients.delete(clientId);
          room.roles.delete(clientId);
          room.names.delete(clientId);
          ws.roomId = null;
          ws.role = null;
          return safeSend(ws, { type: "error", message: "Room exists but host is not online yet." });
        }

        safeSend(ws, {
          type: "joined",
          roomId,
          id: clientId,
          role,
          hostId: room.hostId,
          roster: roster(room),
        });

        // Notify host that a new viewer joined (host will create an offer specifically for this viewer)
        const hostWs = room.clients.get(room.hostId);
        safeSend(hostWs, { type: "viewer_joined", roomId, viewerId: clientId, viewerName: name });

        broadcast(room, { type: "system", message: `${name} joined.` });
      }

      return;
    }

    if (type === "signal") {
      const roomId = ws.roomId;
      if (!roomId) return safeSend(ws, { type: "error", message: "Not in a room" });

      const room = getRoom(roomId);
      if (!room) return safeSend(ws, { type: "error", message: "Room not found" });

      const to = String(msg.to || "").trim();
      const data = msg.data;

      if (!to || !room.clients.has(to)) {
        return safeSend(ws, { type: "error", message: "Invalid 'to' target" });
      }

      // Relay to target
      const targetWs = room.clients.get(to);
      safeSend(targetWs, { type: "signal", roomId, from: clientId, data });

      return;
    }

    if (type === "chat") {
      const roomId = ws.roomId;
      if (!roomId) return safeSend(ws, { type: "error", message: "Not in a room" });

      const room = getRoom(roomId);
      if (!room) return safeSend(ws, { type: "error", message: "Room not found" });

      const message = String(msg.message || "").slice(0, 2000);
      const senderName = room.names.get(clientId) || "User";
      broadcast(room, { type: "chat", roomId, from: clientId, name: senderName, message, ts: Date.now() });
      return;
    }

    if (type === "leave") {
      ws.close();
      return;
    }

    safeSend(ws, { type: "error", message: `Unknown message type: ${type}` });
  });

  ws.on("close", () => {
    const roomId = ws.roomId;
    if (!roomId) return;

    const room = getRoom(roomId);
    if (!room) return;

    const name = room.names.get(clientId) || (ws.role === "host" ? "Host" : "Viewer");

    // Remove from room
    room.clients.delete(clientId);
    room.roles.delete(clientId);
    room.names.delete(clientId);

    // If host left -> close room
    if (room.hostId === clientId) {
      broadcast(room, { type: "host_left", roomId, message: "Host left. Room closed." });
      // Close all clients
      for (const otherWs of room.clients.values()) {
        try { otherWs.close(); } catch {}
      }
      deleteRoom(roomId);
      return;
    }

    // Viewer left
    const hostId = room.hostId;
    if (hostId && room.clients.has(hostId)) {
      safeSend(room.clients.get(hostId), { type: "viewer_left", roomId, viewerId: clientId });
    }
    broadcast(room, { type: "system", message: `${name} left.` });

    // If room became empty -> cleanup
    if (room.clients.size === 0) deleteRoom(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`UltraWatchTogether running on http://localhost:${PORT}`);
});
