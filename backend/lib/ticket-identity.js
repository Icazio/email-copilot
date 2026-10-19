// Older panels sent Ticket# in their subject but did not send ticket_id.
// Only inspect structured metadata/header fields, never customer message bodies.
function resolveTicketIdentity(input = {}) {
  const context = input.thread_context || {};
  const structured = input.thread_structured || context.thread_structured || {};
  for (const value of [input.ticket_id, context.ticket_id, structured.ticket_id]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const identifier = String(value).trim();
    if (identifier && identifier.length <= 300 && !/[\s<>\x00-\x1f]/.test(identifier)) return identifier;
  }
  for (const value of [input.source_url, input.page_url, context.source_url, context.page_url, structured.source_url]) {
    if (typeof value !== 'string' || value.length > 4000) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const match = url.search.match(/(?:[?;&])TicketID=([^;#&]+)/i);
      const identifier = match && decodeURIComponent(match[1]);
      if (identifier && /^\d{1,32}$/.test(identifier)) return url.host + ':' + identifier;
    } catch { /* Malformed metadata is not a ticket identity. */ }
  }
  for (const value of [input.subject, context.subject, structured.ticket_subject]) {
    if (typeof value !== 'string') continue;
    const match = value.match(/^\s*(?:\[\s*)?(?:Ticket\s*#\s*|工单(?:号)?\s*[:：#]\s*)(\d{5,32})(?!\d)/i);
    if (match) return 'ticket-number:' + match[1];
  }
  return '';
}
module.exports = { resolveTicketIdentity };
