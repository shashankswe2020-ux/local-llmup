/**
 * Sanitized GitHub-Flavored Markdown rendering for assistant messages.
 *
 * This classic browser script depends only on the fixed local Marked and
 * DOMPurify bundles loaded before it. It also exposes pure policy helpers for
 * Node unit tests; rendering falls back to plain text when either global is
 * unavailable or parsing fails.
 */
(function attachMarkdown(scope) {
  "use strict";

  const ALLOWED_TAGS = [
    "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4",
    "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "strong",
    "table", "tbody", "td", "th", "thead", "tr", "ul",
  ];
  const ALLOWED_ATTR = [
    "alt", "checked", "class", "disabled", "href", "loading", "src", "title",
    "type",
  ];

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeLinkHref(href) {
    const value = String(href).trim();
    try {
      const protocol = new scope.URL(value).protocol;
      return protocol === "http:" || protocol === "https:" ? value : null;
    } catch {
      return null;
    }
  }

  function safeImageSrc(src) {
    const value = String(src).trim();
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
      return value;
    }
    if (/^\/api\/images\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/i.test(value)) {
      return value;
    }
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/i.test(value)) {
      return `/api/images/${encodeURIComponent(value)}`;
    }
    return null;
  }

  function renderPlainText(container, source) {
    container.textContent = source;
    container.classList.toggle("markdown-fallback", true);
    return false;
  }

  function createRenderer(marked) {
    const renderer = new marked.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.link = function renderLink({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safe = safeLinkHref(href);
      if (safe === null) {
        return label;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${label}</a>`;
    };
    renderer.image = ({ href, title, text }) => {
      const safe = safeImageSrc(href);
      if (safe === null) {
        return escapeHtml(text);
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttr}>`;
    };
    return renderer;
  }

  function enforceRenderedPolicies(container) {
    for (const table of container.querySelectorAll("table")) {
      const wrapper = scope.document.createElement("div");
      wrapper.className = "markdown-table-wrap";
      table.replaceWith(wrapper);
      wrapper.appendChild(table);
    }
    for (const link of container.querySelectorAll("a")) {
      const safe = safeLinkHref(link.getAttribute("href") || "");
      if (safe === null) {
        link.replaceWith(scope.document.createTextNode(link.textContent || ""));
        continue;
      }
      link.setAttribute("href", safe);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    for (const image of container.querySelectorAll("img")) {
      const safe = safeImageSrc(image.getAttribute("src") || "");
      if (safe === null) {
        image.replaceWith(scope.document.createTextNode(image.getAttribute("alt") || ""));
        continue;
      }
      image.setAttribute("src", safe);
      image.classList.add("chat-image");
      image.setAttribute("loading", "lazy");
    }
    for (const checkbox of container.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = true;
      checkbox.tabIndex = -1;
      const item = checkbox.closest("li");
      item?.classList.add("task-list-item");
      item?.parentElement?.classList.add("contains-task-list");
    }
  }

  function renderAssistantMarkdown(container, source) {
    const marked = scope.marked;
    const purify = scope.DOMPurify;
    if (!marked || typeof marked.parse !== "function" || !purify || typeof purify.sanitize !== "function") {
      return renderPlainText(container, source);
    }
    try {
      const parsed = marked.parse(source, {
        async: false,
        breaks: false,
        gfm: true,
        renderer: createRenderer(marked),
      });
      if (typeof parsed !== "string") {
        return renderPlainText(container, source);
      }
      const clean = purify.sanitize(parsed, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        ALLOW_ARIA_ATTR: false,
        ALLOW_DATA_ATTR: false,
      });
      container.innerHTML = String(clean);
      container.classList.toggle("markdown-fallback", false);
      enforceRenderedPolicies(container);
      return true;
    } catch {
      return renderPlainText(container, source);
    }
  }

  function createRenderScheduler(render, options) {
    const scheduleFrame =
      options?.scheduleFrame ?? ((callback) => scope.requestAnimationFrame(callback));
    const cancelFrame =
      options?.cancelFrame ?? ((handle) => scope.cancelAnimationFrame(handle));
    let frameHandle = null;
    let pending = null;

    function update(target, source) {
      pending = { target, source };
      if (frameHandle !== null) {
        return;
      }
      frameHandle = scheduleFrame(() => {
        frameHandle = null;
        const current = pending;
        pending = null;
        if (current !== null) {
          render(current.target, current.source, true);
        }
      });
    }

    function finalize(target, source) {
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      pending = null;
      render(target, source, false);
    }

    return { update, finalize };
  }

  function decorateCodeBlocks(container, options) {
    for (const pre of container.querySelectorAll("pre")) {
      if (pre.querySelector(".code-copy")) {
        continue;
      }
      const code = pre.querySelector("code");
      const text = code ? code.textContent || "" : "";
      const toolbar = scope.document.createElement("div");
      toolbar.className = "code-toolbar";
      const languageMatch = code?.className.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)/);
      if (languageMatch?.[1]) {
        const language = scope.document.createElement("span");
        language.className = "code-language";
        language.textContent = languageMatch[1];
        toolbar.appendChild(language);
      }
      const actions = scope.document.createElement("div");
      actions.className = "code-actions";
      const copy = scope.document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", "Copy code");
      copy.addEventListener("click", () => {
        if (!scope.navigator.clipboard) {
          return;
        }
        scope.navigator.clipboard.writeText(text).then(
          () => {
            copy.textContent = "Copied";
            scope.setTimeout(() => {
              copy.textContent = "Copy";
            }, 1200);
          },
          () => {},
        );
      });
      actions.appendChild(copy);

      const looksHtml =
        (code && /\blanguage-html\b/.test(code.className)) ||
        /<!doctype html|<html[\s>]|<body[\s>]|<div[\s>][\s\S]*<\/div>/i.test(text);
      if (looksHtml && text.trim() && typeof options?.onPreview === "function") {
        const preview = scope.document.createElement("button");
        preview.type = "button";
        preview.className = "code-preview";
        preview.textContent = "Preview";
        preview.setAttribute("aria-label", "Preview HTML code");
        preview.addEventListener("click", () => options.onPreview(text));
        actions.appendChild(preview);
      }
      toolbar.appendChild(actions);
      pre.prepend(toolbar);
    }
  }

  scope.GuiMarkdown = {
    createRenderScheduler,
    decorateCodeBlocks,
    escapeHtml,
    renderAssistantMarkdown,
    safeImageSrc,
    safeLinkHref,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
