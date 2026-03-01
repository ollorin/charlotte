import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "puppeteer";
import { CharlotteError, CharlotteErrorCode } from "../types/errors.js";
import type { ToolDependencies } from "./tool-helpers.js";
import { handleToolError } from "./tool-helpers.js";
import { VideoArtifactStore } from "../state/video-artifact-store.js";
import type { VideoArtifact } from "../state/video-artifact-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveRecording {
  id: string;
  page: Page;
  ffmpegProc: ChildProcess;
  captureTimer: ReturnType<typeof setInterval>;
  outputPath: string;
  format: "webm" | "mp4" | "gif";
  fps: number;
  framesWritten: number;
  startedAt: Date;
  pageUrl: string;
  pageTitle: string;
  /** Set to true when stop is called so the capture loop can exit cleanly. */
  stopping: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFfmpegArgs(
  fps: number,
  format: "webm" | "mp4" | "gif",
  outputPath: string,
): string[] {
  // We pipe raw PNG frames at the configured fps using -framerate.
  const input = [
    "-framerate", String(fps),
    "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
  ];

  if (format === "mp4") {
    return [
      "-loglevel", "error",
      ...input, "-an",
      "-vcodec", "libx264", "-preset", "fast", "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-f", "mp4", "-y", outputPath,
    ];
  }
  if (format === "gif") {
    return [
      "-loglevel", "error",
      ...input,
      "-vf", `fps=${fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      "-f", "gif", "-y", outputPath,
    ];
  }
  // webm / VP9 (default)
  return [
    "-loglevel", "error",
    ...input, "-an",
    "-b:v", "0", "-vcodec", "vp9", "-crf", "30",
    "-deadline", "realtime", "-cpu-used", "4",
    "-f", "webm", "-y", outputPath,
  ];
}

async function spawnFfmpeg(bin: string, args: string[]): Promise<ChildProcess> {
  const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      proc.off("spawn", onSpawn);
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT"
          ? new CharlotteError(
              CharlotteErrorCode.SESSION_ERROR,
              `ffmpeg not found: ${bin}`,
              "Install ffmpeg (e.g. `brew install ffmpeg` or `apt install ffmpeg`) or pass the ffmpegPath option.",
            )
          : err,
      );
    };
    const onSpawn = () => {
      proc.off("error", onError);
      resolve();
    };
    proc.once("error", onError);
    proc.once("spawn", onSpawn);
  });
  // Suppress EPIPE errors if stdin is written after ffmpeg closes
  proc.stdin?.on("error", () => {});
  return proc;
}

/**
 * Wait for a child process to exit. Returns true if it exited normally,
 * false if it was killed due to the timeout (file may be corrupt/incomplete).
 */
function waitForProcess(proc: ChildProcess, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, timeoutMs);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Capture a single PNG frame from the page and pipe it to ffmpeg.
 * Intentionally fire-and-forget from the interval — errors are swallowed
 * so a transient CDP hiccup doesn't crash the recording.
 */
async function captureFrame(recording: ActiveRecording): Promise<void> {
  if (recording.stopping) return;
  try {
    const buf = await recording.page.screenshot({ type: "png", encoding: "binary" }) as Buffer;
    if (!recording.stopping && recording.ffmpegProc.stdin?.writable) {
      recording.ffmpegProc.stdin.write(buf);
      recording.framesWritten++;
    }
  } catch {
    // Page may have navigated or closed — skip this frame
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerScreencastTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  // Fix #1: closure-scoped so each registerScreencastTools call gets its own
  // state — prevents cross-instance leaks in tests or multi-server setups.
  let activeRecording: ActiveRecording | null = null;

  // -------------------------------------------------------------------------
  // charlotte:screencast_start
  // -------------------------------------------------------------------------
  server.registerTool(
    "charlotte:screencast_start",
    {
      description:
        "Start recording a screencast of the active browser page. Uses periodic Page.captureScreenshot + FFmpeg. Requires FFmpeg to be installed.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Output file path. Auto-generated in the screenshot directory if omitted.",
          ),
        format: z
          .enum(["webm", "mp4", "gif"])
          .optional()
          .describe('Output format. Default "webm". All formats require FFmpeg.'),
        fps: z
          .number()
          .min(1)
          .max(60)
          .optional()
          .describe("Frames per second (1–60). Default 25."),
        ffmpegPath: z
          .string()
          .optional()
          .describe("Path to the ffmpeg binary. Required if ffmpeg is not in PATH."),
      },
    },
    async ({ path: outputPathArg, format, fps, ffmpegPath }) => {
      try {
        if (activeRecording !== null) {
          throw new CharlotteError(
            CharlotteErrorCode.SESSION_ERROR,
            "A screencast is already in progress. Call charlotte:screencast_stop first.",
            "Call charlotte:screencast_stop to finish the current recording before starting a new one.",
          );
        }

        await deps.browserManager.ensureConnected();
        const page = deps.pageManager.getActivePage();

        const resolvedFormat = format ?? "webm";
        const resolvedFps = fps ?? 25;
        const ffmpegBin = ffmpegPath ?? "ffmpeg";

        // Fix #4: always pre-generate the id so stop() never has to re-derive
        // it from the path (which breaks for user-supplied paths).
        const id = VideoArtifactStore.generateId();
        const outputPath = outputPathArg
          ?? path.join(deps.videoArtifactStore.dir, `${id}.${resolvedFormat}`);

        const pageUrl = page.url();
        const pageTitle = await page.title();

        // Spawn ffmpeg before starting capture
        const ffmpegArgs = buildFfmpegArgs(resolvedFps, resolvedFormat, outputPath);
        const ffmpegProc = await spawnFfmpeg(ffmpegBin, ffmpegArgs);

        const recording: ActiveRecording = {
          id,
          page,
          ffmpegProc,
          captureTimer: null as unknown as ReturnType<typeof setInterval>,
          outputPath,
          format: resolvedFormat,
          fps: resolvedFps,
          framesWritten: 0,
          startedAt: new Date(),
          pageUrl,
          pageTitle,
          stopping: false,
        };

        // Start the capture loop — one screenshot per frame interval
        const intervalMs = Math.round(1000 / resolvedFps);
        recording.captureTimer = setInterval(() => {
          captureFrame(recording);
        }, intervalMs);

        // Capture the first frame immediately
        await captureFrame(recording);

        activeRecording = recording;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                recording: true,
                id,
                outputPath,
                format: resolvedFormat,
                fps: resolvedFps,
                message: "Recording started. Call charlotte:screencast_stop when done.",
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // charlotte:screencast_stop
  // -------------------------------------------------------------------------
  server.registerTool(
    "charlotte:screencast_stop",
    {
      description:
        "Stop the active screencast recording and save the artifact. Returns the artifact ID, path, format, size, and estimated duration.",
      inputSchema: {},
    },
    async () => {
      try {
        if (activeRecording === null) {
          throw new CharlotteError(
            CharlotteErrorCode.SESSION_ERROR,
            "No active screencast recording to stop.",
            "Start a recording first with charlotte:screencast_start.",
          );
        }

        // Capture and clear immediately so errors don't leave stale state
        const recording = activeRecording;
        activeRecording = null;

        // Signal the capture loop to stop, then clear the interval
        recording.stopping = true;
        clearInterval(recording.captureTimer);

        // Fix #2: waitForProcess now returns false on timeout so we can
        // skip saving a potentially corrupt artifact.
        recording.ffmpegProc.stdin?.end();
        const ffmpegExited = await waitForProcess(recording.ffmpegProc);

        let size = 0;
        let fileMissing = false;
        try {
          const stat = await fs.stat(recording.outputPath);
          size = stat.size;
        } catch {
          fileMissing = true;
        }

        // Fix #4: use the pre-generated id stored on the recording, not
        // a path-derived one that breaks for user-supplied output paths.
        const { id } = recording;
        const filename = path.basename(recording.outputPath);

        const artifact: VideoArtifact = {
          id,
          filename,
          path: recording.outputPath,
          format: recording.format,
          mimeType: VideoArtifactStore.mimeType(recording.format),
          size,
          fps: recording.fps,
          url: recording.pageUrl,
          title: recording.pageTitle,
          timestamp: recording.startedAt.toISOString(),
        };

        await deps.videoArtifactStore.save(artifact);

        const durationMs = Date.now() - recording.startedAt.getTime();
        const durationSec = Math.round(durationMs / 1000);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id,
                path: recording.outputPath,
                format: recording.format,
                fps: recording.fps,
                size,
                frames_written: recording.framesWritten,
                duration_hint: `~${durationSec}s`,
                ...(fileMissing && { warning: "Output file not found — ffmpeg may have errored." }),
                ...(!ffmpegExited && { warning: "ffmpeg encoding timed out and was killed — file may be incomplete." }),
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // charlotte:screencasts
  // -------------------------------------------------------------------------
  server.registerTool(
    "charlotte:screencasts",
    {
      description:
        "List all saved screencast recordings. Returns metadata for each saved recording including ID, filename, page URL, and timestamp.",
      inputSchema: {},
    },
    async () => {
      try {
        const screencasts = deps.videoArtifactStore.list();
        const active = activeRecording
          ? {
              id: activeRecording.id,
              outputPath: activeRecording.outputPath,
              format: activeRecording.format,
              startedAt: activeRecording.startedAt.toISOString(),
            }
          : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                screencasts,
                count: screencasts.length,
                directory: deps.videoArtifactStore.dir,
                active,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // charlotte:screencast_delete
  // -------------------------------------------------------------------------
  server.registerTool(
    "charlotte:screencast_delete",
    {
      description: "Delete a saved screencast recording by its ID.",
      inputSchema: {
        id: z.string().describe("The screencast artifact ID to delete."),
      },
    },
    async ({ id }) => {
      try {
        const deleted = await deps.videoArtifactStore.delete(id);
        if (!deleted) {
          return handleToolError(
            new CharlotteError(
              CharlotteErrorCode.ELEMENT_NOT_FOUND,
              `Screencast '${id}' not found.`,
              "Call charlotte:screencasts to see all available screencast IDs.",
            ),
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                deleted: id,
                remaining: deps.videoArtifactStore.count,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        return handleToolError(error);
      }
    },
  );
}
