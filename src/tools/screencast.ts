import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CharlotteError, CharlotteErrorCode } from "../types/errors.js";
import type { ToolDependencies } from "./tool-helpers.js";
import { handleToolError } from "./tool-helpers.js";
import { VideoArtifactStore } from "../state/video-artifact-store.js";
import type { VideoArtifact } from "../state/video-artifact-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum recording duration before auto-stop (Issue 3). */
const MAX_RECORDING_MS = 5 * 60 * 1000;

/** Maximum stderr buffered from ffmpeg (Issue 4). */
const MAX_STDERR_BYTES = 4096;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveRecording {
  id: string;
  ffmpegProc: ChildProcess;
  /** Resolves when the self-scheduling capture loop exits (Issue 5). */
  captureLoopDone: Promise<void>;
  /** Timer that auto-stops the recording after MAX_RECORDING_MS (Issue 3). */
  autoStopTimer: ReturnType<typeof setTimeout>;
  outputPath: string;
  format: "webm" | "mp4" | "gif";
  fps: number;
  framesWritten: number;
  startedAt: Date;
  pageUrl: string;
  pageTitle: string;
  /** Set to true when stop is called so the capture loop can exit cleanly. */
  stopping: boolean;
  /** Collected stderr from ffmpeg, truncated to MAX_STDERR_BYTES (Issue 4). */
  ffmpegStderr: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFfmpegArgs(
  fps: number,
  format: "webm" | "mp4" | "gif",
  outputPath: string,
): string[] {
  // Issue 6: pipe JPEG frames instead of PNG for smaller frame sizes.
  const input = [
    "-framerate", String(fps),
    "-f", "image2pipe", "-vcodec", "mjpeg", "-i", "pipe:0",
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

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerScreencastTools(
  server: McpServer,
  deps: ToolDependencies,
): () => Promise<void> {
  // Closure-scoped so each registerScreencastTools call gets its own
  // state -- prevents cross-instance leaks in tests or multi-server setups.
  let activeRecording: ActiveRecording | null = null;

  // -----------------------------------------------------------------------
  // Issue 5 + 9: captureFrame and captureLoop are inner functions so they
  // can access `deps` to dynamically resolve the active page (Issue 9).
  // -----------------------------------------------------------------------

  /**
   * Capture a single JPEG frame from the page and pipe it to ffmpeg.
   * Errors are swallowed so a transient CDP hiccup doesn't crash the recording.
   */
  async function captureFrame(recording: ActiveRecording): Promise<void> {
    if (recording.stopping) return;
    try {
      // Issue 9: always get the current active page instead of a stale ref.
      const page = deps.pageManager.getActivePage();
      // Issue 6: use JPEG at quality 80 for smaller frame sizes.
      const buf = await page.screenshot({ type: "jpeg", quality: 80, encoding: "binary" }) as Buffer;
      if (!recording.stopping && recording.ffmpegProc.stdin?.writable) {
        // Issue 15: respect backpressure — if write() returns false, wait
        // for the pipe buffer to drain before continuing.
        const ok = recording.ffmpegProc.stdin.write(buf);
        recording.framesWritten++;
        if (!ok) {
          await new Promise<void>(r => recording.ffmpegProc.stdin!.once("drain", r));
        }
      }
    } catch {
      // Page may have navigated or closed — skip this frame
    }
  }

  /**
   * Issue 5: self-scheduling async loop that replaces setInterval.
   * Prevents concurrent screenshots from piling up when a frame capture
   * takes longer than the interval.
   */
  async function captureLoop(recording: ActiveRecording): Promise<void> {
    const intervalMs = Math.round(1000 / recording.fps);
    while (!recording.stopping) {
      const frameStart = Date.now();
      await captureFrame(recording);
      const elapsed = Date.now() - frameStart;
      const sleepMs = Math.max(0, intervalMs - elapsed);
      if (sleepMs > 0 && !recording.stopping) {
        await new Promise<void>(r => setTimeout(r, sleepMs));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Issue 3 + 8: shared stopRecording helper used by both the tool handler
  // and the auto-stop timer / cleanup function.
  // -----------------------------------------------------------------------

  async function stopRecording(
    recording: ActiveRecording,
    videoArtifactStore: VideoArtifactStore,
  ): Promise<{
    id: string;
    outputPath: string;
    format: string;
    fps: number;
    size: number;
    framesWritten: number;
    durationSec: number;
    ffmpegExited: boolean;
    fileMissing: boolean;
    ffmpegStderr: string;
  }> {
    // Signal the capture loop to stop and wait for it to finish (Issue 5)
    recording.stopping = true;
    clearTimeout(recording.autoStopTimer);
    await recording.captureLoopDone;

    // Close ffmpeg stdin and wait for it to finish encoding
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

    const { id } = recording;
    const filename = path.basename(recording.outputPath);

    // Issue 11: skip saving zero-frame recordings
    // Issue 14: skip saving when ffmpeg timed out or file is missing
    if (recording.framesWritten > 0 && ffmpegExited && !fileMissing) {
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
      await videoArtifactStore.save(artifact);
    }

    const durationMs = Date.now() - recording.startedAt.getTime();
    const durationSec = Math.round(durationMs / 1000);

    return {
      id,
      outputPath: recording.outputPath,
      format: recording.format,
      fps: recording.fps,
      size,
      framesWritten: recording.framesWritten,
      durationSec,
      ffmpegExited,
      fileMissing,
      ffmpegStderr: recording.ffmpegStderr,
    };
  }

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
            "Output file path within the configured video directory. Auto-generated if omitted.",
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
          .describe("Frames per second (1-60). Default 25."),
        ffmpegPath: z
          .string()
          .optional()
          .describe("Path to the ffmpeg binary. Required if ffmpeg is not in PATH."),
      },
    },
    async ({ path: outputPathArg, format, fps, ffmpegPath }) => {
      try {
        // Issue 12: include id and start time in the "already recording" error
        if (activeRecording !== null) {
          throw new CharlotteError(
            CharlotteErrorCode.SESSION_ERROR,
            `A screencast is already in progress (id: ${activeRecording.id}, started ${activeRecording.startedAt.toISOString()}). Call charlotte:screencast_stop first.`,
            "Call charlotte:screencast_stop to finish the current recording before starting a new one.",
          );
        }

        // Issue 2: validate ffmpegPath basename
        if (ffmpegPath) {
          const base = path.basename(ffmpegPath);
          if (base !== "ffmpeg" && base !== "ffmpeg.exe") {
            throw new CharlotteError(
              CharlotteErrorCode.SESSION_ERROR,
              `Invalid ffmpegPath: basename must be "ffmpeg", got "${base}".`,
              'The ffmpegPath must point to an ffmpeg binary (e.g. "/usr/local/bin/ffmpeg").',
            );
          }
        }

        await deps.browserManager.ensureConnected();
        const page = deps.pageManager.getActivePage();

        const resolvedFormat = format ?? "webm";
        const resolvedFps = fps ?? 25;
        const ffmpegBin = ffmpegPath ?? "ffmpeg";

        const id = VideoArtifactStore.generateId();
        let outputPath: string;

        // Issue 1: validate that user-supplied path is within the store dir
        if (outputPathArg) {
          const resolved = path.resolve(outputPathArg);
          const allowedDir = path.resolve(deps.videoArtifactStore.dir);
          if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) {
            throw new CharlotteError(
              CharlotteErrorCode.SESSION_ERROR,
              `Output path must be within the configured video directory: ${allowedDir}`,
              "Omit the path parameter to auto-generate a path, or provide a path within the configured screenshot directory.",
            );
          }
          outputPath = resolved;
        } else {
          outputPath = path.join(deps.videoArtifactStore.dir, `${id}.${resolvedFormat}`);
        }

        const pageUrl = page.url();
        const pageTitle = await page.title();

        // Spawn ffmpeg before starting capture
        const ffmpegArgs = buildFfmpegArgs(resolvedFps, resolvedFormat, outputPath);
        const ffmpegProc = await spawnFfmpeg(ffmpegBin, ffmpegArgs);

        const recording: ActiveRecording = {
          id,
          ffmpegProc,
          captureLoopDone: Promise.resolve(), // replaced below
          autoStopTimer: null as unknown as ReturnType<typeof setTimeout>, // replaced below
          outputPath,
          format: resolvedFormat,
          fps: resolvedFps,
          framesWritten: 0,
          startedAt: new Date(),
          pageUrl,
          pageTitle,
          stopping: false,
          ffmpegStderr: "",
        };

        // Issue 4: collect stderr from ffmpeg (capped at MAX_STDERR_BYTES)
        ffmpegProc.stderr?.on("data", (chunk: Buffer) => {
          if (recording.ffmpegStderr.length < MAX_STDERR_BYTES) {
            recording.ffmpegStderr += chunk.toString().slice(
              0,
              MAX_STDERR_BYTES - recording.ffmpegStderr.length,
            );
          }
        });

        // Issue 5: start the self-scheduling capture loop
        recording.captureLoopDone = captureLoop(recording);

        // Issue 3: auto-stop after MAX_RECORDING_MS
        recording.autoStopTimer = setTimeout(async () => {
          if (activeRecording === recording && !recording.stopping) {
            activeRecording = null;
            await stopRecording(recording, deps.videoArtifactStore);
          }
        }, MAX_RECORDING_MS);

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

        const result = await stopRecording(recording, deps.videoArtifactStore);

        // Issue 11: report zero-frame recordings clearly
        if (result.framesWritten === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: "No frames were captured. The recording was stopped too quickly or the page was not available.",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: result.id,
                path: result.outputPath,
                format: result.format,
                fps: result.fps,
                size: result.size,
                frames_written: result.framesWritten,
                duration_hint: `~${result.durationSec}s`,
                ...(result.fileMissing && { warning: "Output file not found -- ffmpeg may have errored." }),
                ...(!result.ffmpegExited && { warning: "ffmpeg encoding timed out and was killed -- file may be incomplete." }),
                // Issue 4: include ffmpeg stderr when non-empty and exit was abnormal
                ...(result.ffmpegStderr && !result.ffmpegExited && { ffmpeg_stderr: result.ffmpegStderr }),
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

  // Issue 8: return a cleanup function that stops any active recording
  return async () => {
    if (activeRecording) {
      const recording = activeRecording;
      activeRecording = null;
      await stopRecording(recording, deps.videoArtifactStore);
    }
  };
}
