const { readJsonBody, sendJson } = require("./helpers");
const records = require("./records");
const { extractFreeCredit } = require("./mock-engine");

// Returns true when the request was a /records/* route and has been answered.
async function handleRecordRoute(req, res, url, { log }) {
  const pathname = url.pathname;
  if (!pathname.startsWith("/records/")) return false;
  const t0 = Date.now();

  if (req.method === "GET" && pathname === "/records/refund/schema") {
    sendJson(res, 200, await records.refundSchema({ refresh: url.searchParams.get("refresh") === "1" }));
    return true;
  }

  if (req.method !== "POST") return false;
  const body = await readJsonBody(req);

  // { values: {order_id, email, …}, force }
  if (pathname === "/records/refund") {
    const values = body.values || {};
    const previous = values.order_id
      ? records.findPrevious("refund", (e) => e.order_id && e.order_id === values.order_id)
      : [];
    if (previous.length && !body.force) {
      sendJson(res, 409, { ok: false, duplicate: true, previous, error: `订单 ${values.order_id} 已在 ${previous[previous.length - 1].ts.slice(0, 10)} 记录过退款` });
      return true;
    }
    const result = await records.writeRefund(values);
    log("POST /records/refund", { columns: result.written.length, ms: Date.now() - t0 });
    sendJson(res, 200, result);
    return true;
  }

  // Copy & paste mode: build the refund row (sheet column order) and log it.
  // { values, force }
  if (pathname === "/records/refund/row") {
    const values = body.values || {};
    const previous = values.order_id
      ? records.findPrevious("refund", (e) => e.order_id && e.order_id === values.order_id)
      : [];
    if (previous.length && !body.force) {
      sendJson(res, 409, { ok: false, duplicate: true, previous, error: `订单 ${values.order_id} 已在 ${previous[previous.length - 1].ts.slice(0, 10)} 记录过退款` });
      return true;
    }
    const row = records.refundRow(values);
    records.appendLog({ type: "refund", order_id: values.order_id || "", email: values.email || "", ticket: values.ticket || "" });
    log("POST /records/refund/row", { ms: Date.now() - t0 });
    sendJson(res, 200, { ok: true, row });
    return true;
  }

  // Prefill credit values from the captured thread.
  if (pathname === "/records/credit/prefill") {
    const info = extractFreeCredit(body);
    const email = info.customerEmail || "";
    sendJson(res, 200, {
      columns: records.CREDIT_COLUMNS,
      values: {
        date: records.today("."),
        email,
        channels: info.validChannels.join(" "),
        credits: info.totalCredits ? String(info.totalCredits) : "",
        reserved: "",
        links: info.validLinks.join(" ")
      },
      youtube_pending: Boolean(info.youtubeIdPending),
      needs_check: Boolean(info.ambiguousImages || info.screenshotNeedsVerification),
      previous: email ? records.findPrevious("credit", (e) => e.email === email.toLowerCase()) : []
    });
    return true;
  }

  // Agent confirmed the (possibly edited) values: build the row and log it.
  if (pathname === "/records/credit") {
    const values = body.values || {};
    const row = records.creditRow(values);
    records.appendLog({ type: "credit", email: String(values.email || "").toLowerCase(), credits: values.credits || "", ticket: values.ticket || "" });
    log("POST /records/credit", { ms: Date.now() - t0 });
    sendJson(res, 200, { ok: true, row });
    return true;
  }

  return false;
}

module.exports = { handleRecordRoute };
