# Charlotte Screencast Feature — Agent PRD

## Goal

Add video recording capability to Charlotte MCP server using Puppeteer 24's native
`page.screencast()` API. Implement four new MCP tools following Charlotte's existing
patterns exactly.

## Repo

- Fork: https://github.com/ollorin/charlotte
- Local clone: ~/charlotte
- Base branch: main
- Work branch: create `feature/screencast` from main

## Background

Charlotte uses Puppeteer 24.36.1 which has a native `page.screencast()` API:

```typescript
// Returns a ScreenRecorder (Node PassThrough stream)
const recorder = await page.screencast({
  path: './output.webm',   // writes directly to file
  format: 'webm',          // 'webm' | 'mp4' | 'gif'
  fps: 30,
  ffmpegPath: '/path/to/ffmpeg',  // optional, uses PATH by default
});
// ... browser actions happen here ...
await recorder.stop();
```

**Requirements:**
- FFmpeg must be installed (`brew install ffmpeg` on macOS). The tool should check for
  it and return a helpful error if missing.
- `format: 'webm'` works without FFmpeg (Puppeteer handles it natively).
  `mp4` and `gif` require FFmpeg.
- `ScreenRecorder` extends Node's `PassThrough` — it must be `.stop()`'d to finalize.

## Architecture — Follow Existing Patterns Exactly

### Existing patterns to mirror

**Tool registration** — look at `src/tools/observation.ts` and `src/server.ts`:
- Each tool group has a `register*Tools(server, deps)` function
- `deps` contains `browserManager`, `pageManager`, `rendererPipeline`, `artifactStore`, `config`
- Tools use `server.tool(name, description, inputSchema, handler)` pattern with Zod schemas
- Errors return via `CharlotteError` from `src/types/errors.ts`
- Tool names use `charlotte:snake_case` format (note: the MCP tool names have colons)

**Artifact storage** — look at `src/state/artifact-store.ts`:
- Screenshot artifacts: `ss-{timestamp}-{hex}.{ext}` IDs
- Stored in `config.screenshotDir` with a `.charlotte-screenshots.json` index
- `ArtifactStore` class manages CRUD with `save()`, `list()`, `get()`, `readFile()`, `delete()`

**Page access** — `deps.pageManager.getActivePage()` returns the active Puppeteer `Page`

### New file: `src/tools/screencast.ts`

Register these four tools:

---

#### `charlotte:screencast_start`

Starts recording the active browser tab. Recording continues until
`charlotte:screencast_stop` is called.

**Input schema:**
```typescript
{
  path: z.string().optional()
    .describe("Output file path. Default: auto-generated in screenshotDir"),
  format: z.enum(['webm', 'mp4', 'gif']).optional().default('webm')
    .describe("Video format. 'webm' works without FFmpeg; 'mp4'/'gif' require FFmpeg"),
  fps: z.number().min(1).max(60).optional().default(25)
    .describe("Frames per second"),
  ffmpegPath: z.string().optional()
    .describe("Path to ffmpeg binary. Uses PATH if omitted"),
}
```

**Behaviour:**
1. Check no recording is already active (throw if one is)
2. Ensure browser is connected
3. Get active page via `deps.pageManager.getActivePage()`
4. If `path` not provided, auto-generate: `{config.screenshotDir}/rec-{timestamp}-{hex}.{format}`
5. Call `page.screencast({ path, format, fps, ffmpegPath })`
6. Store the `ScreenRecorder` instance and output path in module-level state
7. Return success message with the output path

**Error cases:**
- Recording already active → clear error message
- Browser not connected → rethrow CharlotteError
- FFmpeg not found (mp4/gif format) → helpful error with install instructions

---

#### `charlotte:screencast_stop`

Stops the active recording and saves the file.

**Input schema:** `{}` (no inputs)

**Behaviour:**
1. Check a recording IS active (throw if none)
2. Call `await recorder.stop()`
3. Read the output file to get its size
4. Save a `VideoArtifact` record to the artifact index (see below)
5. Clear module-level recorder state
6. Return: `{ id, path, format, fps, size, duration_hint }`

---

#### `charlotte:screencasts`

Lists all saved screencast artifacts.

**Input schema:** `{}` (no inputs)

**Behaviour:** Return the list from the video artifact index. If none, return empty list.

---

#### `charlotte:screencast_delete`

Deletes a saved screencast by ID.

**Input schema:**
```typescript
{ id: z.string().describe("Screencast artifact ID to delete") }
```

**Behaviour:** Delete the file and remove from index. Error if ID not found.

---

### Video artifact storage

Add a **separate** index file `.charlotte-screencasts.json` in `config.screenshotDir`
(same directory as screenshots). Do NOT modify `ArtifactStore` — create a lightweight
`VideoArtifactStore` class in `src/state/video-artifact-store.ts` mirroring the same
CRUD pattern as `ArtifactStore`.

Video artifact shape:
```typescript
interface VideoArtifact {
  id: string;        // "rec-{timestamp}-{hex}"
  filename: string;  // "rec-{timestamp}-{hex}.webm"
  path: string;      // absolute path
  format: 'webm' | 'mp4' | 'gif';
  mimeType: string;  // "video/webm" | "video/mp4" | "image/gif"
  size: number;      // bytes
  fps: number;
  url: string;       // page URL at time of recording
  title: string;     // page title at time of recording
  timestamp: string; // ISO 8601
}
```

### Wire up in server.ts

After the existing `registerMonitoringTools(...)` call, add:
```typescript
registerScreencastTools(server, toolDeps);
```

Import `registerScreencastTools` from `./tools/screencast.js`.

---

## Module-level recorder state

In `src/tools/screencast.ts`, keep active recording state at module level:

```typescript
interface ActiveRecording {
  recorder: ScreenRecorder;   // from puppeteer
  outputPath: string;
  format: 'webm' | 'mp4' | 'gif';
  fps: number;
  startedAt: Date;
}

let activeRecording: ActiveRecording | null = null;
```

This is intentional — only one recording at a time, matches Charlotte's single-tab-focus model.

---

## Build & test

```bash
cd ~/charlotte
npm install          # no new deps needed — puppeteer already has screencast
npm run build        # tsc, output to dist/
```

Verify build succeeds with zero TypeScript errors.

**Manual smoke test** (run from ~/charlotte after build):
```bash
node dist/index.js &
# In another terminal, use MCP inspector or curl to test tools
```

---

## Checklist

- [ ] `src/tools/screencast.ts` — four tools registered
- [ ] `src/state/video-artifact-store.ts` — VideoArtifactStore class
- [ ] `src/server.ts` — `registerScreencastTools` wired in
- [ ] `npm run build` passes with zero errors
- [ ] `charlotte:screencast_start` starts recording, returns output path
- [ ] `charlotte:screencast_stop` stops recording, saves artifact, returns metadata
- [ ] `charlotte:screencasts` lists saved recordings
- [ ] `charlotte:screencast_delete` deletes by ID
- [ ] Starting a second recording while one is active returns a clear error
- [ ] Stopping when no recording is active returns a clear error
- [ ] `webm` format works (no FFmpeg required)

## Out of scope

- Streaming the video back as base64 in the MCP response (files are too large)
- `charlotte:screencast_get` for downloading (out of scope for now)
- Multiple simultaneous recordings
- Audio recording
- Modifying the existing `ArtifactStore`

## After implementation

Update `~/.claude/.claude.json` to point `charlotte` to `~/charlotte/dist/index.js`
instead of `~/.claude-mcp-servers/charlotte/dist/index.js` so Claude Code uses
the fork with screencast support.
