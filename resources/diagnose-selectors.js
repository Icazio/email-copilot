(function () {
  var r = {};

  // 1. Page detection
  r.isZnunyPage = !!(
    document.querySelector(".MainBox.TicketZoom") ||
    document.querySelector("#ArticleTableBody") ||
    document.querySelector("#ArticleTable") ||
    /Action=AgentTicketZoom/i.test(location.href)
  );
  r.url = location.href.slice(0, 120);

  // 2. Subject
  var subjectSelectors = [
    ".MainBox.TicketZoom .Headline.NoMargin h1",
    ".TicketZoom .Headline h1",
    "h1"
  ];
  for (var i = 0; i < subjectSelectors.length; i++) {
    var el = document.querySelector(subjectSelectors[i]);
    if (el && el.innerText) {
      r.subject_selector = subjectSelectors[i];
      r.subject_text = el.innerText.trim().slice(0, 80);
      break;
    }
  }

  // 3. Article rows
  var rows1 = document.querySelectorAll("#ArticleTableBody tbody tr");
  var rows2 = document.querySelectorAll("#ArticleTable tbody tr");
  r.ArticleTableBody_rows = rows1.length;
  r.ArticleTable_rows = rows2.length;

  // 4. First row fields
  var firstRow = rows1[0] || rows2[0];
  if (firstRow) {
    var aid = firstRow.querySelector("input.ArticleID");
    r["row.ArticleID"] = aid ? aid.value : "not found";
    var sender = firstRow.querySelector(".Sender");
    r["row.Sender"] = sender ? sender.innerText.trim().slice(0, 50) : "not found";
    var created = firstRow.querySelector(".Created");
    r["row.Created"] = created ? created.innerText.trim() : "not found";
    r["row.Direction"] = firstRow.querySelector(".Direction .Incoming")
      ? "incoming"
      : firstRow.querySelector(".Direction .Outgoing")
      ? "outgoing"
      : "not found";
  }

  // 5. iframes for article body
  var iframes = document.querySelectorAll("iframe[id^='Iframe']");
  r.iframe_count = iframes.length;
  if (iframes[0]) r.iframe_src_example = (iframes[0].getAttribute("src") || "").slice(0, 100);

  // 6. Attachments
  var attachLinks = document.querySelectorAll("[id^='TicketAttachment'] .AttachmentElement h3 a");
  r.attachment_links = attachLinks.length;

  // 7. Sidebar customer ID label
  var allLabels = Array.from(document.querySelectorAll("label"));
  var custLabel = null;
  for (var j = 0; j < allLabels.length; j++) {
    if (allLabels[j].textContent && allLabels[j].textContent.trim() === "客户ID:") {
      custLabel = allLabels[j];
      break;
    }
  }
  r.sidebar_customer_id_label = custLabel ? "found" : "not found";
  if (custLabel) {
    var link = custLabel.nextElementSibling && custLabel.nextElementSibling.querySelector("a");
    r.sidebar_customer_id_value = link ? link.textContent.trim() : "link not found";
  }

  // 8. Standard response dropdown
  var opts = document.querySelectorAll("select[id^='ResponseID'] option, select[name='ResponseID'] option");
  r.standard_response_options = opts.length;

  // 9. Email candidates on page
  var emails = (document.body.innerText || "").match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || [];
  var unique = [];
  for (var k = 0; k < emails.length; k++) {
    var e = emails[k].toLowerCase();
    if (unique.indexOf(e) === -1) unique.push(e);
  }
  r.email_candidates = unique.slice(0, 6).join(" | ");

  console.table(r);
  console.log("Full result:", r);
  return r;
})();
