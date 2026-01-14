/* UltraWatchTogether client
   - Host: capture screen, create RTCPeerConnection per viewer, send offer
   - Viewer: receive offer, send answer, play remote stream
*/

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const statsEl = el("stats");
const videoEl = el("video");

const nameEl = el("name");
const createRoomBtn = el("createRoomBtn");
const joinRoomBtn = el("joinRoomBtn");
const roomIdInput = el("roomIdInput");
const roomInfo = el("roomInfo");
const roomIdText = el("roomIdText");
const inviteLinkEl = el("inviteLink");
const copyInviteBtn = el("copyInviteBtn");

const hostControls = el("hostControls");
const startShareBtn = el("startShareBtn");
const stopShareBtn = el("stopShareBtn");
const includeSystemAudioEl = el("includeSystemAudio");
const includeMicEl = el("includeMic");
const qualityEl = el("quality");

const chatLog = el("chatLog");
const chatInput = el("chatInput");
const sendChatBtn = el("sendChatBtn");
const fullscreenBtn = el("fullscreenBtn");

let ws = null;
let selfId = null;
let role = null; // 'host'|'viewer'
let roomId = null;
let hostId = null;

// WebRTC state
let screenStream = null;
let micStream = null;
// peerConnections[peerId] = RTCPeerConnection
const peerConnections = {};
let statsInterval = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function appendChat({ name, message, system = false }) {
  const p = document.createElement("p");
  p.className = "msg";
  if (system) {
    p.innerHTML = `<span class="sys">[system]</span> ${escapeHtml(message)}`;
  } else {
    p.innerHTML = `<span class="who">${escapeHtml(name)}:</span> ${escapeHtml(message)}`;
  }
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function wsUrl() {
  return location.origin.replace(/^http/, "ws");
}

function parseUrlRoom() {
  const u = new URL(location.href);
  const r = u.searchParams.get("room");
  return r ? r.trim() : "";
}

function getDisplayConstraints() {
  const q = qualityEl.value;
  const base = { video: {}, audio: includeSystemAudioEl.checked };
  if (q === "720p30") {
    base.video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  } else if (q === "1080p30") {
    base.video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } };
  } else if (q === "1080p60") {
    base.video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
  } else if (q === "1440p30") {
    base.video = { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30, max: 30 } };
  }
  return base;
}

function connectWs() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    ws.onmessage = (evt) => handleWsMessage(evt.data);
    ws.onclose = () => {
      setStatus("Disconnected.");
      cleanupAllPeers();
      stopStreams();
      stopStats();
    };
  });
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

async function createRoom() {
  const res = await fetch("/api/new-room");
  const data = await res.json();
  return data.roomId;
}

function showRoomInfo() {
  roomInfo.classList.remove("hidden");
  roomIdText.textContent = roomId;

  const invite = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  inviteLinkEl.value = invite;

  // If viewer joined via URL, show its room in box too.
  roomIdInput.value = roomId;
}

function setRoleUi(newRole) {
  role = newRole;
  if (role === "host") {
    hostControls.classList.remove("hidden");
    videoEl.muted = true; // host preview muted
  } else {
    hostControls.classList.add("hidden");
    videoEl.muted = false;
  }
}

function iceConfig() {
  // You can add TURN here later for reliability across restrictive NATs.
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478?transport=udp" }
    ]
  };
}

function makePeerConnection(remoteId) {
  const pc = new RTCPeerConnection(iceConfig());

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: "signal", to: remoteId, data: { candidate: event.candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    // Useful for debugging
    // console.log("pc state", remoteId, pc.connectionState);
  };

  pc.ontrack = (event) => {
    // Viewer will receive stream tracks here
    if (role === "viewer") {
      const [stream] = event.streams;
      if (stream) videoEl.srcObject = stream;
    }
  };

  return pc;
}

function addLocalTracks(pc) {
  if (screenStream) {
    for (const track of screenStream.getTracks()) pc.addTrack(track, screenStream);
  }
  if (micStream) {
    for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);
  }
}

async function hostCreateOfferForViewer(viewerId) {
  if (!screenStream) {
    appendChat({ system: true, message: "Viewer joined, but you haven't started sharing yet." });
    return;
  }

  // Create per-viewer PC
  const pc = makePeerConnection(viewerId);
  peerConnections[viewerId] = pc;

  addLocalTracks(pc);

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);

  send({ type: "signal", to: viewerId, data: { description: pc.localDescription } });
}

async function viewerHandleOffer(fromId, description) {
  hostId = fromId;

  let pc = peerConnections[fromId];
  if (!pc) {
    pc = makePeerConnection(fromId);
    peerConnections[fromId] = pc;
  }

  await pc.setRemoteDescription(description);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  send({ type: "signal", to: fromId, data: { description: pc.localDescription } });
}

async function handleRemoteCandidate(fromId, candidate) {
  const pc = peerConnections[fromId];
  if (!pc) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (e) {
    // Can happen if candidate arrives before remote description is set
    // In practice, browsers handle most of this; still log for debugging.
    console.warn("addIceCandidate failed", e);
  }
}

function cleanupPeer(peerId) {
  const pc = peerConnections[peerId];
  if (pc) {
    try { pc.close(); } catch {}
    delete peerConnections[peerId];
  }
}

function cleanupAllPeers() {
  for (const id of Object.keys(peerConnections)) cleanupPeer(id);
}

async function startSharing() {
  if (role !== "host") return;

  stopStreams();

  try {
    const constraints = getDisplayConstraints();
    screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);

    if (includeMicEl.checked) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
    }

    // Show preview
    videoEl.srcObject = screenStream;

    // If the host stops screen-share via browser UI, tear down.
    const vTrack = screenStream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.addEventListener("ended", () => {
        appendChat({ system: true, message: "Screen share ended." });
        stopSharing();
      });
    }

    startShareBtn.classList.add("hidden");
    stopShareBtn.classList.remove("hidden");

    setStatus(`Sharing. Waiting for viewers…`);
    startStats();

    // For any existing viewers (joined before sharing) create offers now
    // (We don't have roster IDs on client beyond server events; but host will still receive viewer_joined events for new viewers.)
    // If you restart sharing mid-session, recreate offers for current viewers.
    for (const viewerId of Object.keys(peerConnections)) {
      cleanupPeer(viewerId);
    }
    // Ask server for roster? Not needed; instead, viewers can refresh, or you can stop/start session.
    // Practical: viewers joining after you start share will work immediately.
  } catch (err) {
    console.error(err);
    appendChat({ system: true, message: `Failed to start sharing: ${err.message}` });
    setStatus("Share failed.");
  }
}

function stopStreams() {
  if (screenStream) {
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
  }
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
}

function stopSharing() {
  if (role !== "host") return;

  stopStreams();
  cleanupAllPeers();
  stopStats();

  startShareBtn.classList.remove("hidden");
  stopShareBtn.classList.add("hidden");
  setStatus("Not sharing.");
  videoEl.srcObject = null;
}

function startStats() {
  stopStats();
  statsInterval = setInterval(async () => {
    try {
      // Show quick stats for first peer (if any)
      const ids = Object.keys(peerConnections);
      if (ids.length === 0) {
        statsEl.textContent = "";
        return;
      }
      const pc = peerConnections[ids[0]];
      const stats = await pc.getStats();
      let out = null, inp = null;
      stats.forEach((report) => {
        if (report.type === "outbound-rtp" && report.kind === "video" && report.bytesSent != null) out = report;
        if (report.type === "inbound-rtp" && report.kind === "video" && report.bytesReceived != null) inp = report;
      });

      if (role === "host" && out) {
        statsEl.textContent = `sending to ${ids.length} viewer(s)`;
      } else if (role === "viewer" && inp) {
        statsEl.textContent = `receiving`;
      }
    } catch {
      // ignore
    }
  }, 1500);
}

function stopStats() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = null;
  statsEl.textContent = "";
}

function handleWsMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.type === "hello") {
    selfId = msg.id;
    return;
  }

  if (msg.type === "joined") {
    setStatus(`Connected as ${msg.role}. Room: ${msg.roomId}`);
    if (msg.hostId) hostId = msg.hostId;
    return;
  }

  if (msg.type === "host_ready") {
    // Viewer only: host is now online (if you joined early)
    if (role === "viewer") hostId = msg.hostId;
    return;
  }

  if (msg.type === "viewer_joined") {
    // Host: create offer for this viewer
    if (role === "host") {
      const viewerId = msg.viewerId;
      const viewerName = msg.viewerName || "Viewer";
      appendChat({ system: true, message: `${viewerName} connected.` });
      // Prepare PC if we are currently sharing
      hostCreateOfferForViewer(viewerId).catch((e) => console.error(e));
    }
    return;
  }

  if (msg.type === "viewer_left") {
    if (role === "host") {
      cleanupPeer(msg.viewerId);
      appendChat({ system: true, message: `Viewer left.` });
      setStatus(`Sharing. ${Object.keys(peerConnections).length} viewer(s) connected.`);
    }
    return;
  }

  if (msg.type === "host_left") {
    appendChat({ system: true, message: msg.message || "Host left." });
    setStatus("Host left. Room closed.");
    cleanupAllPeers();
    stopStreams();
    stopStats();
    return;
  }

  if (msg.type === "system") {
    appendChat({ system: true, message: msg.message });
    return;
  }

  if (msg.type === "chat") {
    appendChat({ name: msg.name || "User", message: msg.message || "" });
    return;
  }

  if (msg.type === "signal") {
    const fromId = msg.from;
    const data = msg.data || {};

    if (data.description) {
      const desc = data.description;
      if (desc.type === "offer" && role === "viewer") {
        viewerHandleOffer(fromId, desc).catch((e) => console.error(e));
      } else if (desc.type === "answer" && role === "host") {
        const pc = peerConnections[fromId];
        if (!pc) return;
        pc.setRemoteDescription(desc).catch((e) => console.error(e));
        setStatus(`Sharing. ${Object.keys(peerConnections).length} viewer(s) connected.`);
      }
    }

    if (data.candidate) {
      handleRemoteCandidate(fromId, data.candidate).catch((e) => console.error(e));
    }

    return;
  }

  if (msg.type === "error") {
    appendChat({ system: true, message: `Error: ${msg.message}` });
    setStatus(`Error: ${msg.message}`);
  }
}

async function joinAs(newRole, rid) {
  if (!rid) {
    appendChat({ system: true, message: "Room ID missing." });
    return;
  }

  const name = (nameEl.value || "").trim() || (newRole === "host" ? "Host" : "Viewer");

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus("Connecting…");
    await connectWs();
  }

  setRoleUi(newRole);

  roomId = rid;
  showRoomInfo();

  send({ type: "join", roomId, role: newRole, name });
}

createRoomBtn.addEventListener("click", async () => {
  try {
    const rid = await createRoom();
    await joinAs("host", rid);
    setStatus(`Room created: ${rid}. Start sharing when ready.`);
    // Also update URL to keep the room if you refresh
    const u = new URL(location.href);
    u.searchParams.set("room", rid);
    history.replaceState(null, "", u.toString());
  } catch (e) {
    console.error(e);
    setStatus("Failed to create room.");
  }
});

joinRoomBtn.addEventListener("click", async () => {
  const rid = roomIdInput.value.trim() || parseUrlRoom();
  await joinAs("viewer", rid);
});

startShareBtn.addEventListener("click", () => startSharing());
stopShareBtn.addEventListener("click", () => stopSharing());

copyInviteBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLinkEl.value);
    appendChat({ system: true, message: "Invite link copied." });
  } catch {
    inviteLinkEl.select();
    document.execCommand("copy");
    appendChat({ system: true, message: "Invite link copied (fallback)." });
  }
});

sendChatBtn.addEventListener("click", () => {
  const msg = chatInput.value.trim();
  if (!msg) return;
  send({ type: "chat", message: msg });
  chatInput.value = "";
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChatBtn.click();
});

fullscreenBtn.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    videoEl.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

// Auto-fill roomId if joined via link
const autoRoom = parseUrlRoom();
if (autoRoom) {
  roomIdInput.value = autoRoom;
  setStatus("Room link detected. Enter a name and click Join.");
}
