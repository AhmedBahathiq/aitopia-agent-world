const [engineUrl, seasonId] = process.argv.slice(2);
if (!engineUrl || !seasonId) throw new Error("Usage: node check-staging.mjs <engine-url> <season-id>");

const base = `${engineUrl}/api/seasons/${encodeURIComponent(seasonId)}`;
const endpoints = [
  `${base}/snapshot?view=social`,
  `${base}/snapshot?view=omniscient`,
  `${base}/events?cursor=0&view=social`,
  `${base}/analytics`,
  `${base}/discoveries`,
  `${base}/history/timeline?view=social&atDay=0&asOfDay=0`,
  `${base}/history/deceased`,
  `${base}/history/family-tree`,
  `${base}/history/entities`,
  `${base}/history/impact-ranking`,
  `${base}/replay?atDay=0&view=social&asOfDay=0`,
  `${base}/map?bbox=0,0,100,100&cursor=0`,
];

const responses = await Promise.all(endpoints.map(async (url) => {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`${new URL(url).pathname}: ${body.error ?? response.status}`);
  return body.data;
}));

const snapshot = responses[0];
if (snapshot.status !== "paused" || snapshot.simDay !== 0 || snapshot.livingPopulation !== 3) throw new Error("staging season is not paused cleanly at day zero");
if ("usage" in snapshot || "worldTruth" in snapshot || "seed" in snapshot) throw new Error("private state leaked through public snapshot");

const wsUrl = new URL(engineUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = `/agents/public-stream-agent/${encodeURIComponent(seasonId)}`;
const streamResult = await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl);
  const timeout = setTimeout(() => { socket.close(); reject(new Error("websocket_timeout")); }, 5_000);
  socket.onmessage = (message) => {
    const payload = JSON.parse(String(message.data));
    const state = payload.state ?? payload;
    if (state.seasonId === seasonId) { clearTimeout(timeout); socket.close(); resolve("connected"); }
  };
  socket.onerror = () => { clearTimeout(timeout); reject(new Error("websocket_failed")); };
});

console.log(JSON.stringify({ endpoints: endpoints.length, status: snapshot.status, simDay: snapshot.simDay, living: snapshot.livingPopulation, aiUsageExposed: "usage" in snapshot, websocket: streamResult }));
