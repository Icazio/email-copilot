const fs = require("fs");
const path = require("path");
const { readJsonBody, sendJson } = require("./helpers");

const LOG_FILE = path.join(__dirname, "../logs/queue-routing.jsonl");

function appendLog(entry) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
}

// Returns true when the request was a /queue-routing/* route and has been answered.
async function handleQueueRoutingRoute(req, res, pathname, { routing, log }) {
  if (!pathname.startsWith("/queue-routing/")) return false;

  if (req.method === "GET" && pathname === "/queue-routing/table") {
    sendJson(res, 200, routing.table());
    return true;
  }

  if (req.method !== "POST") return false;
  const body = await readJsonBody(req);

  if (pathname === "/queue-routing/classify") {
    const result = routing.classify(body);
    sendJson(res, 200, { ticket_id: body.ticket_id, ...result });
    return true;
  }

  if (pathname === "/queue-routing/learn") {
    const result = routing.learn(body);
    log("POST /queue-routing/learn", { samples: (body.samples || []).length, ...result });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // The queue page reports every move (suggested or not) so wrong
  // suggestions can be reviewed later.
  if (pathname === "/queue-routing/moved") {
    const { ticket_id, from, to, suggested, confidence, auto } = body;
    appendLog({ type: "moved", ticket_id, from, to, suggested, confidence, auto: Boolean(auto) });
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleQueueRoutingRoute };
