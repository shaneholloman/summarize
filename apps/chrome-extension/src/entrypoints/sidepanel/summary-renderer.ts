import { selectMarkdownForLayout } from "./slides-state";
import { buildSummaryEmptyState } from "./summary-empty-state";
import { linkifyTimestamps } from "./timestamp-links";

function createCopyButton({
  text,
  headerSetStatus,
}: {
  text: string;
  headerSetStatus: (text: string) => void;
}) {
  const button = document.createElement("button");
  button.className = "ghost icon render__copy";
  button.type = "button";
  button.setAttribute("aria-label", "Copy summary");
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
    </svg>
  `;
  button.addEventListener("click", () => {
    void copySummaryText({ text, headerSetStatus });
  });
  return button;
}

async function copySummaryText({
  text,
  headerSetStatus,
}: {
  text: string;
  headerSetStatus: (text: string) => void;
}) {
  const trimmed = text.trim();
  if (!trimmed) {
    headerSetStatus("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(trimmed);
    headerSetStatus("Copied");
    return;
  } catch {
    // fallback
  }
  const selection = document.getSelection();
  const range = document.createRange();
  const ghost = document.createElement("textarea");
  ghost.value = trimmed;
  ghost.setAttribute("readonly", "true");
  ghost.style.position = "fixed";
  ghost.style.opacity = "0";
  document.body.append(ghost);
  ghost.focus();
  ghost.select();
  const ok = document.execCommand("copy");
  ghost.remove();
  selection?.removeAllRanges();
  range.detach();
  headerSetStatus(ok ? "Copied" : "Copy failed");
}

export function renderSummaryEmptyState({
  hostEl,
  state,
}: {
  hostEl: HTMLElement;
  state: ReturnType<typeof buildSummaryEmptyState>;
}) {
  if (!state) {
    hostEl.innerHTML = "";
    return;
  }
  const wrapper = document.createElement("section");
  wrapper.className = "renderEmpty";
  wrapper.dataset.emptyState = "true";
  const label = document.createElement("div");
  label.className = "renderEmpty__label";
  label.textContent = state.label;
  const message = document.createElement("p");
  message.className = "renderEmpty__message";
  message.textContent = state.message;
  wrapper.append(label, message);
  if (state.detail) {
    const detail = document.createElement("p");
    detail.className = "renderEmpty__detail";
    detail.textContent = state.detail;
    wrapper.append(detail);
  }
  hostEl.replaceChildren(wrapper);
}

export function renderSummaryMarkdownDisplay({
  activeTabUrl,
  autoSummarize,
  currentSourceTitle,
  currentSourceUrl,
  hasSlides,
  headerSetStatus,
  hostEl,
  inputMode,
  markdown,
  md,
  phase,
  renderInlineSlides,
  slidesEnabled,
  slidesLayout,
  tabTitle,
  tabUrl,
}: {
  activeTabUrl: string | null;
  autoSummarize: boolean;
  currentSourceTitle: string | null;
  currentSourceUrl: string | null;
  hasSlides: boolean;
  headerSetStatus: (text: string) => void;
  hostEl: HTMLElement;
  inputMode: "page" | "video";
  markdown: string;
  md: { render: (value: string) => string };
  phase: string;
  renderInlineSlides: (container: HTMLElement, opts?: { fallback?: boolean }) => void;
  slidesEnabled: boolean;
  slidesLayout: string;
  tabTitle: string | null;
  tabUrl: string | null;
}) {
  const displayMarkdown = selectMarkdownForLayout({
    markdown,
    slidesEnabled,
    inputMode,
    hasSlides,
    slidesLayout,
  });
  if (!displayMarkdown.trim()) {
    renderSummaryEmptyState({
      hostEl,
      state: buildSummaryEmptyState({
        tabTitle: currentSourceTitle ?? tabTitle ?? null,
        tabUrl: currentSourceUrl ?? tabUrl ?? activeTabUrl ?? null,
        autoSummarize,
        phase,
        hasSlides,
      }),
    });
    return;
  }
  try {
    hostEl.innerHTML = "";
    const actions = document.createElement("div");
    actions.className = "render__actions";
    actions.append(createCopyButton({ text: displayMarkdown, headerSetStatus }));
    const markdownHost = document.createElement("div");
    markdownHost.className = "render__markdownBody";
    markdownHost.innerHTML = md.render(linkifyTimestamps(displayMarkdown));
    hostEl.append(actions, markdownHost);
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    headerSetStatus(`Error: ${message}`);
    return;
  }
  for (const a of Array.from(hostEl.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("timestamp:")) {
      a.classList.add("chatTimestamp");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      continue;
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  renderInlineSlides(hostEl, { fallback: true });
}
