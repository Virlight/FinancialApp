export function renderAssistantMessage(message) {
  const lines = normalizeAssistantMarkdown(message).split("\n");
  const html = [];
  let listType = null;
  let listItems = [];

  function flushList() {
    if (!listType || listItems.length === 0) {
      listType = null;
      listItems = [];
      return;
    }

    html.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listType = null;
    listItems = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);

    if (headingMatch) {
      flushList();
      const level = Math.min(headingMatch[1].length + 2, 4);
      html.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);

    if (bulletMatch) {
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }

      listItems.push(`<li>${formatInlineMarkdown(bulletMatch[1])}</li>`);
      continue;
    }

    const orderedMatch = line.match(/^\d+[.)]\s+(.+)$/);

    if (orderedMatch) {
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }

      listItems.push(`<li>${formatInlineMarkdown(orderedMatch[1])}</li>`);
      continue;
    }

    flushList();
    html.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  flushList();

  return `<div class="assistant-markdown">${html.join("")}</div>`;
}

export function normalizeAssistantMarkdown(message) {
  return String(message || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\*[ \t]+(?=(?:\*\*|\[|[\u4e00-\u9fffA-Za-z0-9]))/g, "\n- ")
    .replace(/[ \t]+-[ \t]+(?=(?:\*\*|\[|[\u4e00-\u9fffA-Za-z0-9]))/g, "\n- ")
    .replace(/([:：])\s*(?=-\s+)/g, "$1\n")
    .trim();
}

function formatInlineMarkdown(text) {
  const source = String(text || "");
  const markdownLinkPattern = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;
  let html = "";
  let lastIndex = 0;
  let match = markdownLinkPattern.exec(source);

  while (match) {
    html += formatPlainInline(source.slice(lastIndex, match.index));
    html += renderSafeLink(match[2], match[1]);
    lastIndex = match.index + match[0].length;
    match = markdownLinkPattern.exec(source);
  }

  html += formatPlainInline(source.slice(lastIndex));
  return html;
}

function formatPlainInline(text) {
  const source = String(text || "");
  const urlPattern = /https?:\/\/[^\s<]+/g;
  let html = "";
  let lastIndex = 0;
  let match = urlPattern.exec(source);

  while (match) {
    html += formatTextEmphasis(source.slice(lastIndex, match.index));
    const { url, suffix } = splitTrailingUrlPunctuation(match[0]);
    html += renderSafeLink(url, url);
    html += escapeHtml(suffix);
    lastIndex = match.index + match[0].length;
    match = urlPattern.exec(source);
  }

  html += formatTextEmphasis(source.slice(lastIndex));
  return html;
}

function formatTextEmphasis(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function splitTrailingUrlPunctuation(rawUrl) {
  const match = String(rawUrl || "").match(/^(.+?)([.,;:!?，。；：！？）)]*)$/);

  return {
    url: match?.[1] || rawUrl,
    suffix: match?.[2] || ""
  };
}

function renderSafeLink(url, label) {
  const safeUrl = String(url || "");
  const safeLabel = label && label !== safeUrl ? label : humanizeUrlLabel(safeUrl);

  if (!/^https?:\/\//i.test(safeUrl)) {
    return escapeHtml(label || safeUrl);
  }

  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${formatTextEmphasis(safeLabel)}</a>`;
}

function humanizeUrlLabel(url) {
  try {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const lastPart = decodeURIComponent(pathParts.at(-1) || parsedUrl.hostname)
      .replace(/\.(html|jsp|php)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
    const label = lastPart && lastPart !== parsedUrl.hostname ? lastPart : parsedUrl.hostname;

    return `${parsedUrl.hostname.replace(/^www\./, "")} / ${label}`;
  } catch {
    return url;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
