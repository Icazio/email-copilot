(function () {
  const DEFAULT_SUBJECT_SELECTORS = [
    ".MainBox.TicketZoom .Headline.NoMargin h1",
    ".TicketZoom .Headline h1",
    "[data-testid='mail-subject']",
    "[data-testid='ticket-subject']",
    "[data-subject]",
    ".mail-subject",
    ".ticket-subject",
    ".subject",
    "h1",
    "title"
  ];

  const DEFAULT_THREAD_SELECTORS = [
    "#ArticleTableBody",
    "#ArticleTree",
    ".MainBox.TicketZoom",
    "[data-testid='mail-thread']",
    "[data-testid='conversation-thread']",
    "[data-testid='ticket-thread']",
    ".mail-thread",
    ".message-thread",
    ".conversation-thread",
    ".conversation",
    ".thread",
    "[role='main']",
    "main",
    "article",
    "body"
  ];

  const DEFAULT_MESSAGE_SELECTORS = [
    "#ArticleTableBody tbody tr",
    "#ArticleTable tbody tr",
    "[data-testid='message-item']",
    "[data-testid='mail-message']",
    ".message-item",
    ".mail-message",
    ".thread-message",
    ".message",
    ".email-message"
  ];

  function cleanText(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function splitSelectors(value, fallback) {
    const items = String(value || "")
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : fallback;
  }

  function describeElement(element, selector) {
    if (!element) {
      return null;
    }

    const tag = element.tagName ? element.tagName.toLowerCase() : "unknown";
    const id = element.id ? `#${element.id}` : "";
    const className =
      typeof element.className === "string" && element.className.trim()
        ? "." + element.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";

    return {
      selector,
      node: `${tag}${id}${className}`,
      length: cleanText(element.innerText || "").length
    };
  }

  function textFromSelectors(selectors) {
    const inspected = [];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      inspected.push(describeElement(element, selector));
      const text = cleanText(element?.innerText || "");
      if (text) {
        return {
          text,
          matchedSelector: selector,
          inspected
        };
      }
    }

    return {
      text: "",
      matchedSelector: null,
      inspected
    };
  }

  function stripTicketPrefix(subject) {
    return cleanText(String(subject || "").replace(/^Ticket#\S+\s*(?:[—–-]\s*)?/i, ""));
  }

  function extractSortData(cell) {
    return cleanText(cell?.querySelector(".SortData")?.value || "");
  }

  function extractSemicolonParam(text, key) {
    const match = String(text || "").match(new RegExp(`${key}=([^;#&]+)`, "i"));
    return match ? decodeURIComponent(match[1]) : "";
  }

function extractEmailsFromText(text) {
    const matches = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return matches
      .map((item) => cleanText(item).toLowerCase())
      .filter(Boolean)
      .filter((item, index, items) => items.indexOf(item) === index);
  }

  function extractLabeledCustomerEmails(text) {
    const matches = Array.from(
      String(text || "").matchAll(/\bcustomer\s*email(?:\s*address)?\s*[:：]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)
    );

    return matches
      .map((match) => cleanText(match?.[1] || "").toLowerCase())
      .filter(Boolean)
      .filter((item, index, items) => items.indexOf(item) === index);
  }

  function filterCustomerEmails(emails) {
    return emails.filter(
      (email) => !/(support@avclabs\.com|assist@paddle\.com)$/i.test(email)
    );
  }

  function collectPageEmailCandidates() {
    const labeledEmails = extractLabeledCustomerEmails(document.body?.innerText || "");
    const pageTextEmails = extractEmailsFromText(document.body?.innerText || "");
    const mailtoEmails = Array.from(document.querySelectorAll("a[href^='mailto:']"))
      .map((node) => cleanText((node.getAttribute("href") || "").replace(/^mailto:/i, "")))
      .filter(Boolean);

    return filterCustomerEmails([...labeledEmails, ...pageTextEmails, ...mailtoEmails])
      .filter((item, index, items) => items.indexOf(item) === index)
      .slice(0, 20);
  }

  function collectZnunySubject() {
    const selected = textFromSelectors(DEFAULT_SUBJECT_SELECTORS);
    return {
      subject: stripTicketPrefix(selected.text.split("\n")[0].slice(0, 300)),
      matchedSelector: selected.matchedSelector,
      inspected: selected.inspected
    };
  }

  function collectAttachmentFilenames(articleId) {
    const container = document.querySelector(`#TicketAttachment${articleId}`);
    if (!container) return [];
    return Array.from(container.querySelectorAll(".AttachmentElement h3 a"))
      .map((a) => cleanText(a.textContent || ""))
      .filter(Boolean);
  }

  function collectCustomerIdFromSidebar() {
    const label = Array.from(document.querySelectorAll("label")).find(
      (el) => cleanText(el.textContent) === "客户ID:"
    );
    return cleanText(label?.nextElementSibling?.querySelector("a")?.textContent || "");
  }

  function collectZnunyRows() {
    const rows = Array.from(document.querySelectorAll("#ArticleTableBody tbody tr, #ArticleTable tbody tr"))
      .filter((row) => row.querySelector(".Sender, .Subject, .Created"));

    const items = rows.map((row) => {
      const number = cleanText(row.querySelector(".No")?.childNodes?.[0]?.textContent || "");
      const articleId = cleanText(row.querySelector("input.ArticleID")?.value || "");
      const articleInfo = cleanText(row.querySelector("input.ArticleInfo")?.value || "");
      const sender = cleanText(row.querySelector(".Sender")?.innerText || "");
      const subject = cleanText(row.querySelector(".Subject")?.innerText || "");
      const created =
        extractSortData(row.querySelector(".Created")) ||
        cleanText(row.querySelector(".Created")?.innerText || "");
      const directionNode = row.querySelector(".Direction .Incoming, .Direction .Outgoing");
      const direction = directionNode?.classList.contains("Outgoing") ? "outgoing" : "incoming";
      const status = row.classList.contains("Active") ? "active" : "listed";
      const attachments = collectAttachmentFilenames(articleId);

      return {
        number,
        article_id: articleId,
        article_info: articleInfo,
        sender,
        subject,
        created,
        direction,
        status,
        attachments
      };
    });

    return items.filter((item) => item.sender || item.subject || item.created || item.article_id);
  }

  function getTicketId() {
    return (
      extractSemicolonParam(location.href, "TicketID") ||
      cleanText(document.querySelector("input[name='TicketID']")?.value || "")
    );
  }

  function getIframeUrlMap() {
    return new Map(
      Array.from(document.querySelectorAll("iframe[id^='Iframe']"))
        .map((iframe) => {
          const articleId = iframe.id.replace(/^Iframe/, "");
          return [articleId, iframe.getAttribute("src") || ""];
        })
        .filter(([articleId, src]) => articleId && src)
    );
  }

  function buildArticleContentUrl(ticketId, articleId, iframeUrlMap) {
    const iframeSrc = iframeUrlMap.get(articleId);
    if (iframeSrc) {
      try {
        return new URL(iframeSrc, location.origin).toString();
      } catch (_error) {
        return iframeSrc;
      }
    }

    if (!ticketId || !articleId) {
      return "";
    }

    return `${location.origin}/otrs/index.pl?Action=AgentTicketArticleContent;Subaction=HTMLView;TicketID=${encodeURIComponent(ticketId)};ArticleID=${encodeURIComponent(articleId)};FileID=;`;
  }

  function parseArticleBodyFromHtml(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    const bodyNode = doc.querySelector(".ArticleBody");
    const source = bodyNode || doc.body;

    if (!source) {
      return "";
    }

    source.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    source.querySelectorAll("p, div, li, ul, ol, h1, h2, h3, h4, h5, h6").forEach((node) => {
      if (node.lastChild?.nodeType !== Node.TEXT_NODE || !String(node.textContent || "").endsWith("\n")) {
        node.append("\n");
      }
    });

    const bodyText = cleanText(source.textContent || "");
    return bodyText;
  }

  function simplifyArticleBodyForDisplay(body, row) {
    let text = cleanText(body);
    const sender = cleanText(row?.sender || "");
    const isOfficialSupport = /avclabs support team|support@avclabs\.com/i.test(sender);
    const lines = text.split("\n").map((line) => cleanText(line));

    if (!isOfficialSupport && /^dear\b.{0,60},?$/i.test(lines[0] || "")) {
      lines.shift();
      text = cleanText(lines.join("\n"));
    }

    if (isOfficialSupport) {
      text = text.replace(
        /\n(?:best regards|kind regards|sincerely)[\s\S]*$/i,
        ""
      );
    } else {
      text = text.replace(
        /\n(?:best regards|kind regards|regards|sincerely|cheers)[\s\S]*$/i,
        ""
      );
    }

    text = text.replace(/\nOfficial Website:\s*\S+.*$/gim, "");
    text = text.replace(/\nEmail:\s*support@avclabs\.com.*$/gim, "");
    text = text.replace(/\n.*Find Us on Facebook:.*$/gim, "");
    text = text.replace(/\n.*Follow Us on Twitter:.*$/gim, "");
    text = text.replace(/\n.*Subscribe to the YouTube Channel:.*$/gim, "");
    text = text.replace(/\n.*Don.?t Miss the Biggest Deals of the Year!.*$/gim, "");
    text = text.replace(/\n.*AI Photo Editor makes photo editing easier.*$/gim, "");
    text = text.replace(/\n.*To enhance video quality, please refer to.*$/gim, "");
    text = text.replace(/\n.*To blur video background.*$/gim, "");
    text = text.replace(/\n.*Our Partner: All-In-One Video Downloader.*$/gim, "");

    return cleanText(text);
  }

  function dedupeQuotedHistory(body, previousBodies) {
    const text = cleanText(body);
    if (!text) {
      return "";
    }

    const inlineQuotePatterns = [
      /\bOn .{0,240} wrote:\s*/i,
      /\bIl giorno .{0,240} ha scritto:\s*/i
    ];

    let normalizedText = text;
    for (const pattern of inlineQuotePatterns) {
      const match = normalizedText.match(pattern);
      if (match && match.index > 0) {
        normalizedText = cleanText(normalizedText.slice(0, match.index));
        break;
      }
    }

    const lines = normalizedText.split("\n");
    const genericQuotePatterns = [
      /^from:\s/i,
      /^sent:\s/i,
      /^to:\s/i,
      /^subject:\s/i,
      /^>+\s?/,
      /^={3,}$/,
      /^-{3,}$/
    ];

    let bestCutIndex = lines.length;

    for (const previousBody of previousBodies) {
      const normalizedPrevious = cleanText(previousBody);
      if (!normalizedPrevious || normalizedPrevious.length < 40) {
        continue;
      }

      const previousPrefix = normalizedPrevious.slice(0, 240);
      const overlapIndex = normalizedText.indexOf(previousPrefix);
      if (overlapIndex > 0) {
        const overlapPrefix = cleanText(normalizedText.slice(0, overlapIndex));
        const overlapLineCount = overlapPrefix ? overlapPrefix.split("\n").length : 0;
        if (overlapLineCount > 0) {
          bestCutIndex = Math.min(bestCutIndex, overlapLineCount);
        }
      }
    }

    if (bestCutIndex === lines.length) {
      for (let index = 0; index < lines.length; index += 1) {
        const trimmed = cleanText(lines[index]);
        if (!trimmed) {
          continue;
        }

        if (genericQuotePatterns.some((pattern) => pattern.test(trimmed))) {
          bestCutIndex = index;
          break;
        }
      }
    }

    const deduped = cleanText(lines.slice(0, bestCutIndex).join("\n"));
    return deduped || normalizedText || text;
  }

  async function fetchArticleBodies(rows) {
    const ticketId = getTicketId();
    const iframeUrlMap = getIframeUrlMap();
    const candidates = rows.filter((row) => row.article_id).slice(0, 30);

    const results = await Promise.all(
      candidates.map(async (row) => {
        const url = buildArticleContentUrl(ticketId, row.article_id, iframeUrlMap);
        if (!url) {
          return {
            article_id: row.article_id,
            body: "",
            fetch_url: "",
            ok: false
          };
        }

        try {
          const response = await fetch(url, {
            credentials: "include"
          });

          if (!response.ok) {
            return {
              article_id: row.article_id,
              body: "",
              fetch_url: url,
              ok: false
            };
          }

          const htmlText = await response.text();
          return {
            article_id: row.article_id,
            body: parseArticleBodyFromHtml(htmlText),
            fetch_url: url,
            ok: true
          };
        } catch (_error) {
          return {
            article_id: row.article_id,
            body: "",
            fetch_url: url,
            ok: false
          };
        }
      })
    );

    return results;
  }

  function buildReadableZnunyThread(rows, fetchedBodies) {
    const rawBodyMap = new Map(
      fetchedBodies
        .filter((item) => item.article_id)
        .map((item) => [item.article_id, cleanText(item.body || "")])
    );
    const displayBodyMap = new Map();
    const previousBodies = [];

    [...rows]
      .sort((a, b) => Number(a.number || 0) - Number(b.number || 0))
      .forEach((row) => {
        const simplified = simplifyArticleBodyForDisplay(rawBodyMap.get(row.article_id) || "", row);
        const deduped = dedupeQuotedHistory(simplified, previousBodies);
        displayBodyMap.set(row.article_id, deduped);
        previousBodies.push(deduped || simplified);
      });

    const sections = rows
      .sort((a, b) => Number(b.number || 0) - Number(a.number || 0))
      .map((row) => {
        const body = displayBodyMap.get(row.article_id) || "";
        const lines = [];

        if (row.sender) {
          lines.push(`From: ${row.sender}`);
        }
        if (row.created) {
          lines.push(`Date: ${row.created}`);
        }
        if (body) {
          lines.push("");
          lines.push(body);
        }

        return cleanText(lines.join("\n"));
      })
      .filter(Boolean);

    if (sections.length) {
      return cleanText(sections.join("\n\n--------------------------------------------------------------------------\n\n")).slice(0, 40000);
    }

    return "";
  }

  async function collectZnunyThreadText() {
    const rows = collectZnunyRows();
    const fetchedBodies = await fetchArticleBodies(rows);
    const ticketSubject = collectZnunySubject().subject;
    const pageEmailCandidates = collectPageEmailCandidates();
    const readableThreadText = buildReadableZnunyThread(rows, fetchedBodies);
    const fetchedBodyCount = fetchedBodies.filter((item) => item.body).length;
    const activeArticleBody = fetchedBodies.find((item) => item.body)?.body || "";

    return {
      thread_text: readableThreadText || activeArticleBody,
      matchedSelector: "#ArticleTableBody tbody tr",
      mode: "znuny-ticket-network",
      rowCount: rows.length,
      visiblePanelCount: 0,
      iframeBodyCount: fetchedBodyCount,
      articleBodyLength: activeArticleBody.length,
      rows,
      structured: {
        page_type: "znuny-ticket",
        ticket_subject: ticketSubject,
        articles: rows.map((row) => ({
          ...row,
          body: fetchedBodies.find((item) => item.article_id === row.article_id)?.body || ""
        })),
        active_article_body: activeArticleBody,
        iframe_articles: fetchedBodies,
        customer_email_candidates: pageEmailCandidates,
        customer_email: pageEmailCandidates[0] || "",
        customer_id_email: collectCustomerIdFromSidebar(),
      }
    };
  }

  function isZnunyTicketPage() {
    return Boolean(
      document.querySelector(".MainBox.TicketZoom, #ArticleTableBody, #ArticleTable") ||
        /Action=AgentTicketZoom/i.test(location.href)
    );
  }

  function collectMessageItems(messageSelectors) {
    for (const selector of messageSelectors) {
      const nodes = Array.from(document.querySelectorAll(selector))
        .map((node) => cleanText(node.innerText || ""))
        .filter((text) => text.length > 20);

      if (nodes.length >= 2) {
        return {
          selector,
          text: nodes.join("\n\n---\n\n").slice(0, 20000)
        };
      }
    }

    return {
      selector: null,
      text: ""
    };
  }

  function collectThreadText(threadSelectors, messageSelectors) {
    const messageBased = collectMessageItems(messageSelectors);
    if (messageBased.text) {
      return {
        thread_text: messageBased.text,
        matchedSelector: messageBased.selector,
        mode: "message-list"
      };
    }

    const selected = textFromSelectors(threadSelectors);

    return {
      thread_text: selected.text.slice(0, 20000),
      matchedSelector: selected.matchedSelector,
      inspected: selected.inspected,
      mode: "container"
    };
  }

  function collectSubject(subjectSelectors) {
    const selected = textFromSelectors(subjectSelectors);
    return {
      subject: selected.text.split("\n")[0].slice(0, 300),
      matchedSelector: selected.matchedSelector,
      inspected: selected.inspected
    };
  }

  function collectDebugInfo(subjectResult, threadResult, subjectSelectors, threadSelectors, messageSelectors) {
    return {
      page_title: document.title,
      url: location.href,
      frame_context: window.top === window ? "top" : "iframe",
      page_type: isZnunyTicketPage() ? "znuny-ticket" : "generic",
      subject_selector_used: subjectResult.matchedSelector,
      thread_selector_used: threadResult.matchedSelector,
      thread_mode: threadResult.mode,
      subject_selectors: subjectSelectors,
      thread_selectors: threadSelectors,
      message_selectors: messageSelectors,
      subject_candidates: subjectResult.inspected || [],
      thread_candidates: threadResult.inspected || [],
      znuny_row_count: threadResult.rowCount || 0,
      znuny_visible_panel_count: threadResult.visiblePanelCount || 0,
      znuny_iframe_body_count: threadResult.iframeBodyCount || 0,
      znuny_article_body_length: threadResult.articleBodyLength || 0,
      znuny_iframe_ids: (threadResult.structured?.iframe_articles || [])
        .slice(0, 10)
        .map((item) => item.article_id || item.fetch_url || ""),
      customer_email_candidates: threadResult.structured?.customer_email_candidates || [],
      standard_responses: []
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "EMAIL_COPILOT_EXTRACT") {
      return false;
    }

    const subjectSelectors = splitSelectors(message.subject_selectors, DEFAULT_SUBJECT_SELECTORS);
    const threadSelectors = splitSelectors(message.thread_selectors, DEFAULT_THREAD_SELECTORS);
    const messageSelectors = splitSelectors(message.message_selectors, DEFAULT_MESSAGE_SELECTORS);

    (async () => {
      const subjectResult = isZnunyTicketPage()
        ? collectZnunySubject()
        : collectSubject(subjectSelectors);
      const threadResult = isZnunyTicketPage()
        ? await collectZnunyThreadText()
        : collectThreadText(threadSelectors, messageSelectors);

      sendResponse({
        frame_url: location.href,
        frame_context: window.top === window ? "top" : "iframe",
        url: location.href,
        title: document.title,
        subject: subjectResult.subject,
        thread_text: threadResult.thread_text,
        thread_structured: threadResult.structured || null,
        debug: collectDebugInfo(subjectResult, threadResult, subjectSelectors, threadSelectors, messageSelectors)
      });
    })().catch((error) => {
      sendResponse({
        frame_url: location.href,
        frame_context: window.top === window ? "top" : "iframe",
        error: error?.message || String(error)
      });
    });

    return true;
  });
})();
