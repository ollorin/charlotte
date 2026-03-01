import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScreenRecorder } from "puppeteer-core";
import { CharlotteError, CharlotteErrorCode } from "../types/errors.js";
import type { ToolDependencies } from "./tool-helpers.js";
import { handleToolError } from "./tool-helpers.js";
import { VideoArtifactStore } from "../state/video-artifact-store.js";
import type { VideoArtifact } from "../state/video-artifact-store.js";

// ---------------------------------------------------------------------------
// Module-level recording state
// ---------------------------------------------------------------------------

interface ActiveRecording {
  recorder: ScreenRecorder;
  outputPath: string;
  format: "webm" | "mp4" | "gif";
  fps: number;
  startedAt: Date;
  pageUrl: string;
  pageTitle: string;
}

let activeRecording: ActiveRecording | null = null;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerScreencastTools(
  server: McpServer,
  deps: ToolDependencies,
): void {
  // -------------------------------------------------------------------------
  // charlotte:screencast_start
  // -------------------------------------------------------------------------
  server.registerTool(
    "charlotte:screencast_start",
    {
      description:
        "Start recording a screencast of the active browser page. Recordings are saved as WebM by default. MP4 and GIF formats require FFmpeg to be installed.",
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
          .describe('Output format. Default "webm". mp4/gif require FFmpeg.'),
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

        // Auto-generate output path if not provided
        let outputPath: string;
        if (outputPathArg) {
          outputPath = outputPathArg;
        } else {
          const id = VideoArtifactStore.generateId();
          const dir = deps.config.screenshotDir ?? os.tmpdir();
          outputPath = path.join(dir, `${id}.${resolvedFormat}`);
        }

        // Capture page metadata before recording starts
        const pageUrl = page.url();
        const pageTitle = await page.title();

        // Build screencast options matching the Puppeteer 24 API
        const screencastOptions: {
          path?: `${string}.${typeof resolvedFormat}`;
          format?: typeof resolvedFormat;
          fps?: number;
          ffmpegPath?: string;
        } = {
          path: outputPath as `${string}.${typeof resolvedFormat}`,
          format: resolvedFormat,
          fps: resolvedFps,
        };
        if (ffmpegPath) {
          screencastOptions.ffmpegPath = ffmpegPath;
        }

        let recorder: ScreenRecorder;
        try {
          recorder = await page.screencast(screencastOptions);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/ffmpeg/i.test(msg)) {
            throw new CharlotteError(
              CharlotteErrorCode.SESSION_ERROR,
              `Screencast failed: ffmpeg not found. ${msg}`,
              "Install ffmpeg (e.g. `brew install ffmpeg` or `apt install ffmpeg`) and ensure it is in your PATH, or pass the ffmpegPath option.",
            );
          }
          throw err;
        }

        activeRecording = {
          recorder,
          outputPath,
          format: resolvedFormat,
          fps: resolvedFps,
          startedAt: new Date(),
          pageUrl,
          pageTitle,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                recording: true,
                outputPath,
                format: resolvedFormat,
                fps: resolvedFps,
                message: "Recording started. Call charlotte:screencast_stop when done.",
              }),
            },
          ],
        };
      } catch (err) {
        return handleToolError(err);
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

        // Capture and clear activeRecording immediately so errors don't leave stale state
        const recording = activeRecording;
        activeRecording = null;

        await recording.recorder.stop();

        // Get file size (default 0 if stat fails)
        let size = 0;
        try {
          const stat = fs.statSync(recording.outputPath);
          size = stat.size;
        } catch {
          // File may not exist or may still be flushing — treat as 0
        }

        const ext = path.extname(recording.outputPath);
        const id = path.basename(recording.outputPath, ext);
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
        const duration_hint = `~${durationSec}s`;

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
                duration_hint,
              }),
            },
          ],
        };
      } catch (err) {
        return handleToolError(err);
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
      } catch (err) {
        return handleToolError(err);
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
          throw new CharlotteError(
            CharlotteErrorCode.ELEMENT_NOT_FOUND,
            `Screencast '${id}' not found.`,
            "Call charlotte:screencasts to see all available screencast IDs.",
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
      } catch (err) {
        return handleToolError(err);
      }
    },
  );
}
