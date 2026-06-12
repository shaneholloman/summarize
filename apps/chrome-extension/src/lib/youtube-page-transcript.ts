export type BrowserYouTubeTranscript =
  | {
      ok: true;
      url: string;
      text: string;
      transcriptTimedText: string;
      truncated: boolean;
      durationSeconds: number | null;
    }
  | { ok: false; error: string };

// Keep this function self-contained: Chrome serializes it for MAIN-world injection.
export async function extractYouTubePageTranscript(
  limit: number,
  allowPanelFallback = true,
): Promise<BrowserYouTubeTranscript> {
  type CaptionTrack = {
    baseUrl?: unknown;
    languageCode?: unknown;
    kind?: unknown;
    name?: { simpleText?: unknown; runs?: Array<{ text?: unknown }> };
  };
  type PlayerResponse = {
    captions?: {
      playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
    };
    videoDetails?: { lengthSeconds?: unknown; videoId?: unknown };
  };

  const clampText = (text: string, maxLength: number) => {
    if (text.length <= maxLength) return { text, truncated: false };
    return {
      text: `${text.slice(0, Math.max(0, maxLength - 24))}\n\n[TRUNCATED]`,
      truncated: true,
    };
  };
  const labelForTrack = (track: CaptionTrack) => {
    if (typeof track.name?.simpleText === "string") return track.name.simpleText;
    if (Array.isArray(track.name?.runs)) {
      return track.name.runs
        .map((run) => (typeof run.text === "string" ? run.text : ""))
        .join("")
        .trim();
    }
    return "";
  };
  const sortCaptionTracks = (tracks: CaptionTrack[]) => {
    const score = (track: CaptionTrack) => {
      const language =
        typeof track.languageCode === "string" ? track.languageCode.toLowerCase() : "";
      const label = labelForTrack(track).toLowerCase();
      const isAutomatic = track.kind === "asr" || label.includes("auto-generated");
      return [
        language === "en" || language.startsWith("en-") ? 0 : 10,
        isAutomatic ? 1 : 0,
        label.includes("english") ? 0 : 1,
      ].join(":");
    };
    return tracks
      .filter((track) => typeof track.baseUrl === "string")
      .sort((left, right) => score(left).localeCompare(score(right)));
  };
  const formatTimestamp = (ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const two = (value: number) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
  };
  const normalizeCaptionText = (text: string) =>
    text
      .replace(/\s+/g, " ")
      .replace(/&nbsp;/g, " ")
      .trim();
  const parseJson3 = (raw: string) => {
    const data = JSON.parse(raw) as {
      events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
    };
    return (data.events ?? [])
      .map((event) => ({
        startMs: typeof event.tStartMs === "number" ? event.tStartMs : null,
        text: normalizeCaptionText((event.segs ?? []).map((seg) => seg.utf8 ?? "").join("")),
      }))
      .filter((line) => line.text.length > 0);
  };
  const parseXml = (raw: string) =>
    Array.from(new DOMParser().parseFromString(raw, "text/xml").querySelectorAll("text"))
      .map((node) => {
        const start = Number(node.getAttribute("start"));
        return {
          startMs: Number.isFinite(start) ? Math.round(start * 1000) : null,
          text: normalizeCaptionText(node.textContent ?? ""),
        };
      })
      .filter((line) => line.text.length > 0);
  const parseVtt = (raw: string) => {
    const lines: Array<{ startMs: number | null; text: string }> = [];
    let pendingStart: number | null = null;
    let pendingText: string[] = [];
    const flush = () => {
      const text = normalizeCaptionText(pendingText.join(" "));
      if (text) lines.push({ startMs: pendingStart, text });
      pendingStart = null;
      pendingText = [];
    };
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      const timing = trimmed.match(/^(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->/);
      if (timing) {
        flush();
        const parts = trimmed.split(/\s+-->\s+/)[0].split(":");
        const secondsPart = parts.pop() ?? "0";
        const minutes = Number(parts.pop() ?? "0");
        const hours = Number(parts.pop() ?? "0");
        const seconds = Number(secondsPart);
        pendingStart = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
        continue;
      }
      if (trimmed === "WEBVTT" || /^\d+$/.test(trimmed)) continue;
      pendingText.push(trimmed);
    }
    flush();
    return lines;
  };
  const captionUrls = (baseUrl: string) => {
    const withFormat = (format: string) => {
      const url = new URL(baseUrl);
      url.searchParams.set("fmt", format);
      return url.toString();
    };
    return Array.from(new Set([withFormat("json3"), baseUrl, withFormat("vtt")]));
  };
  const fetchWithTimeout = async (url: string, timeoutMs = 5000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const fetchLines = async (track: CaptionTrack) => {
    if (typeof track.baseUrl !== "string") return [];
    for (const url of captionUrls(track.baseUrl)) {
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) continue;
        const raw = (await res.text()).trim();
        if (!raw) continue;
        const lines = raw.startsWith("{")
          ? parseJson3(raw)
          : raw.startsWith("WEBVTT")
            ? parseVtt(raw)
            : parseXml(raw);
        if (lines.length > 0) return lines;
      } catch {
        // Try the next track/format.
      }
    }
    return [];
  };
  const findBalancedJsonAfter = (source: string, marker: string) => {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = source.indexOf("{", markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return null;
  };
  const activeVideoId = (() => {
    try {
      const url = new URL(location.href);
      return url.searchParams.get("v") ?? url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  const asObject = (value: unknown) =>
    value && typeof value === "object" ? (value as PlayerResponse) : undefined;
  const hasCaptionTracks = (player: PlayerResponse | undefined) =>
    Boolean(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
  const isCurrentPlayer = (player: PlayerResponse | undefined, requireVideoId: boolean) => {
    if (!player || !activeVideoId) return Boolean(player);
    const playerVideoId = player.videoDetails?.videoId;
    if (typeof playerVideoId === "string") return playerVideoId === activeVideoId;
    return !requireVideoId;
  };
  const globalData = globalThis as typeof globalThis & {
    ytInitialPlayerResponse?: unknown;
  };
  const flexy = document.querySelector("ytd-watch-flexy") as
    | (Element & { playerData?: unknown; playerResponse?: unknown })
    | null;
  const playerCandidates = [
    asObject(flexy?.playerData),
    asObject(flexy?.playerResponse),
    asObject(globalData.ytInitialPlayerResponse),
  ].filter((candidate): candidate is PlayerResponse => Boolean(candidate));
  let player = activeVideoId
    ? (playerCandidates.find((candidate) => candidate.videoDetails?.videoId === activeVideoId) ??
      playerCandidates.find(
        (candidate) =>
          typeof candidate.videoDetails?.videoId !== "string" && hasCaptionTracks(candidate),
      ))
    : (playerCandidates.find(hasCaptionTracks) ?? playerCandidates[0]);
  if (!player) {
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = script.textContent ?? "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const raw = findBalancedJsonAfter(text, "ytInitialPlayerResponse");
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as PlayerResponse;
        if (isCurrentPlayer(parsed, true)) {
          player = parsed;
          break;
        }
      } catch {
        // Keep scanning; YouTube has several script shapes.
      }
    }
  }

  const duration =
    typeof player?.videoDetails?.lengthSeconds === "string"
      ? Number(player.videoDetails.lengthSeconds)
      : null;
  const durationSeconds = Number.isFinite(duration) ? duration : null;
  const buildResult = (
    raw: string,
  ): Extract<BrowserYouTubeTranscript, { ok: true }> | { ok: false; error: string } => {
    const normalized = raw.trim();
    if (!normalized) return { ok: false, error: "No YouTube caption transcript found." };
    const clamped = clampText(`Transcript:\n${normalized}`, limit);
    const timed = clampText(normalized, limit);
    return {
      ok: true,
      url: location.href,
      text: clamped.text,
      transcriptTimedText: timed.text,
      truncated: clamped.truncated,
      durationSeconds,
    };
  };

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  for (const track of sortCaptionTracks(tracks)) {
    const lines = await fetchLines(track);
    if (lines.length === 0) continue;
    return buildResult(
      lines
        .map((line) =>
          typeof line.startMs === "number"
            ? `[${formatTimestamp(line.startMs)}] ${line.text}`
            : line.text,
        )
        .join("\n"),
    );
  }

  if (!allowPanelFallback) {
    return { ok: false, error: "No YouTube caption transcript found." };
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const parseTranscriptPanel = () => {
    const segments = Array.from(
      document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model"),
    );
    return segments
      .map((segment) => {
        const textEl = segment.querySelector(
          "#segment-text, .segment-text, .ytAttributedStringHost[role='text'], span[role='text']",
        );
        const timestampEl = segment.querySelector(
          "#timestamp, .segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp",
        );
        const text = normalizeCaptionText(textEl?.textContent ?? "");
        const timestamp = normalizeCaptionText(timestampEl?.textContent ?? "");
        const timestampMatch = timestamp.match(/^\d{1,2}:\d{2}(?::\d{2})?$/);
        return {
          timestamp: timestampMatch ? timestamp : null,
          text,
        };
      })
      .filter((line) => line.text.length > 0);
  };
  const clickTranscriptButton = async () => {
    document.querySelector("ytd-watch-metadata")?.scrollIntoView({ block: "center" });
    await delay(120);
    const buttons = () =>
      Array.from(document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer"));
    const expand = buttons().find((element) =>
      /\bmore\b/i.test(normalizeCaptionText(element.textContent ?? "")),
    ) as HTMLElement | undefined;
    expand?.click();
    await delay(250);
    const transcriptButton = (document.querySelector(
      "ytd-video-description-transcript-section-renderer button",
    ) ??
      buttons().find((element) =>
        /show transcript/i.test(normalizeCaptionText(element.textContent ?? "")),
      )) as HTMLElement | undefined;
    if (!transcriptButton) return false;
    transcriptButton.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(200);
      if (parseTranscriptPanel().length > 0) return true;
    }
    return false;
  };
  const pageWindow = globalThis as typeof globalThis & {
    scrollX?: number;
    scrollY?: number;
    scrollTo?: (x: number, y: number) => void;
  };
  const scrollBeforeFallback = {
    x: pageWindow.scrollX ?? 0,
    y: pageWindow.scrollY ?? 0,
  };
  try {
    if (await clickTranscriptButton()) {
      const panelLines = parseTranscriptPanel();
      if (panelLines.length > 0) {
        return buildResult(
          panelLines
            .map((line) => (line.timestamp ? `[${line.timestamp}] ${line.text}` : line.text))
            .join("\n"),
        );
      }
    }
  } finally {
    pageWindow.scrollTo?.(scrollBeforeFallback.x, scrollBeforeFallback.y);
  }
  return { ok: false, error: "No YouTube caption transcript found." };
}
