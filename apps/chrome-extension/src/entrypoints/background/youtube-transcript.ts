import {
  extractYouTubePageTranscript,
  type BrowserYouTubeTranscript,
} from "../../lib/youtube-page-transcript";

export async function hasYouTubeCaptionTracksInTab(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        type PlayerResponse = {
          captions?: {
            playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] };
          };
          videoDetails?: { videoId?: unknown };
        };
        const asPlayer = (value: unknown): PlayerResponse | null =>
          value && typeof value === "object" ? (value as PlayerResponse) : null;
        const activeVideoId =
          new URL(location.href).searchParams.get("v") ??
          location.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ??
          null;
        const globals = globalThis as typeof globalThis & {
          ytInitialPlayerResponse?: unknown;
        };
        const flexy = document.querySelector("ytd-watch-flexy") as
          | (Element & { playerData?: unknown; playerResponse?: unknown })
          | null;
        const moviePlayer = document.querySelector("#movie_player") as
          | (Element & { getPlayerResponse?: () => unknown })
          | null;
        const candidates = [
          asPlayer(moviePlayer?.getPlayerResponse?.()),
          asPlayer(flexy?.playerData),
          asPlayer(flexy?.playerResponse),
          asPlayer(globals.ytInitialPlayerResponse),
        ].filter((value): value is PlayerResponse => Boolean(value));
        const player =
          candidates.find((candidate) => candidate.videoDetails?.videoId === activeVideoId) ?? null;
        return Boolean(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
      },
    });
    return result?.result !== false;
  } catch {
    return true;
  }
}

export async function extractYouTubeTranscriptInTab(
  tabId: number,
  maxChars: number,
): Promise<BrowserYouTubeTranscript> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [maxChars, true],
      func: extractYouTubePageTranscript,
    });
    return result.result ?? { ok: false, error: "No transcript result returned." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
