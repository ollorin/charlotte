import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { logger } from "../utils/logger.js";

export interface VideoArtifact {
  id: string;        // "rec-{timestamp}-{hex}"
  filename: string;  // "rec-{timestamp}-{hex}.webm"
  path: string;      // absolute path
  format: "webm" | "mp4" | "gif";
  mimeType: string;  // "video/webm" | "video/mp4" | "image/gif"
  size: number;      // bytes
  fps: number;
  url: string;       // page URL at time of recording
  title: string;     // page title at time of recording
  timestamp: string; // ISO 8601
}

/** Fields actually persisted in the JSON index. `path`, `filename`, and
 *  `mimeType` are omitted because they are fully derivable from `id`,
 *  `format`, and the store's runtime `_dir`. */
interface IndexEntry {
  id: string;
  format: "webm" | "mp4" | "gif";
  fps: number;
  url: string;
  title: string;
  timestamp: string;
}

const INDEX_FILE = ".charlotte-screencasts.json";

export class VideoArtifactStore {
  private artifacts = new Map<string, VideoArtifact>();
  private _dir: string;

  constructor(dir?: string) {
    this._dir = dir ?? path.join(os.tmpdir(), "charlotte-screencasts");
  }

  get dir(): string {
    return this._dir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this._dir, { recursive: true });
    await this.loadIndex();
    logger.info("Video artifact store initialized", { dir: this._dir });
  }

  /** Update the video directory at runtime (e.g. after charlotte:configure).
   *  Clears the in-memory index and reloads from the new location.
   *  Does not move existing files. */
  async setDir(dir: string): Promise<void> {
    this._dir = dir;
    this.artifacts.clear();
    await this.initialize();
  }

  async save(artifact: VideoArtifact): Promise<void> {
    this.artifacts.set(artifact.id, artifact);
    await this.saveIndex();
    logger.info("Screencast saved", { id: artifact.id, size: artifact.size });
  }

  list(): VideoArtifact[] {
    return Array.from(this.artifacts.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  get(id: string): VideoArtifact | undefined {
    return this.artifacts.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const artifact = this.artifacts.get(id);
    if (!artifact) return false;

    try {
      await fs.unlink(artifact.path);
    } catch {
      // File already gone — still clean up index
    }

    this.artifacts.delete(id);
    await this.saveIndex();
    logger.info("Screencast deleted", { id });
    return true;
  }

  get count(): number {
    return this.artifacts.size;
  }

  // generateId is static so the screencast tool can pre-generate the artifact
  // ID — and therefore the output file path — *before* calling
  // `page.screencast()`, which requires the destination path up front.
  static generateId(): string {
    const now = new Date();
    const datePart = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rand = crypto.randomBytes(3).toString("hex");
    return `rec-${datePart}-${rand}`;
  }

  static mimeType(format: "webm" | "mp4" | "gif"): string {
    if (format === "gif") return "image/gif";
    return `video/${format}`;
  }

  private get indexPath(): string {
    return path.join(this._dir, INDEX_FILE);
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf-8");
      const entries: IndexEntry[] = JSON.parse(raw);
      for (const entry of entries) {
        // Reconstruct derived fields from the store's authoritative _dir so
        // the index is safe to move/rename without stale absolute paths.
        const filename = `${entry.id}.${entry.format}`;
        const filePath = path.join(this._dir, filename);
        const mimeType = VideoArtifactStore.mimeType(entry.format);
        try {
          const stat = await fs.stat(filePath);
          this.artifacts.set(entry.id, {
            ...entry,
            filename,
            path: filePath,
            mimeType,
            size: stat.size,
          });
        } catch {
          // File missing — skip
        }
      }
      logger.info("Loaded video artifact index", { count: this.artifacts.size });
    } catch {
      // No index yet — fresh start
    }
  }

  private async saveIndex(): Promise<void> {
    // Persist only the minimal IndexEntry fields; derived fields (path,
    // filename, mimeType) are reconstructed on load.
    const entries: IndexEntry[] = Array.from(this.artifacts.values()).map(
      ({ id, format, fps, url, title, timestamp }) => ({
        id,
        format,
        fps,
        url,
        title,
        timestamp,
      }),
    );
    await fs.writeFile(this.indexPath, JSON.stringify(entries, null, 2));
  }
}
