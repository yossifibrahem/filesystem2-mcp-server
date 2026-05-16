import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFile as execFileCallback, ExecFileException } from "child_process";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * The character threshold above which a full view is truncated into
 * beginning + tail sections, matching Claude's ~16 000 char budget.
 */
const VIEW_CHAR_LIMIT = 16_000;

/**
 * Maximum directory depth shown when viewing a directory (2 levels).
 */
const DIR_MAX_DEPTH = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a byte count into a human-readable size string (K / M / G). */
function humanSize(bytes: number): string {
  if (bytes === 0) return "0";
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

/**
 * Recursively compute the total size of a directory (in bytes).
 * Symlinks are not followed to avoid infinite loops.
 */
function dirSize(dirPath: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        total += dirSize(fullPath);
      } else {
        total += fs.statSync(fullPath).size;
      }
    }
  } catch {
    /* ignore permission errors */
  }
  return total;
}

/**
 * Build a directory listing string matching the view tool output format.
 *
 * The output is a tab-separated list of `size\tpath` lines,
 * where the root entry comes first and each item is indented by depth.
 *
 * Example:
 *   28K\t/home/claude/testdir
 *   16K\t/home/claude/testdir/level1a
 *    0\t/home/claude/testdir/level1a/file.txt
 *
 * Hidden items (starting with ".") and node_modules are excluded.
 * Only 2 levels deep are shown from the root.
 */
function buildDirListing(
  rootPath: string,
  currentPath: string,
  depth: number,
  lines: string[]
): void {
  const stat = fs.statSync(currentPath);

  if (stat.isDirectory()) {
    const size = dirSize(currentPath);
    lines.push(`${humanSize(size)}\t${currentPath}`);

    if (depth >= DIR_MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then files, both alphabetically
    const dirs = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          e.name !== "node_modules"
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of [...dirs, ...files]) {
      buildDirListing(
        rootPath,
        path.join(currentPath, entry.name),
        depth + 1,
        lines
      );
    }
  } else {
    // File entry: show its size
    const size = stat.size;
    const sizeStr = size === 0 ? "0" : humanSize(size);
    lines.push(`${sizeStr}\t${currentPath}`);
  }
}

/**
 * Format file contents with 1-based line numbers, matching the view tool.
 *
 * Each line is prefixed with right-aligned line number + TAB:
 *   "     1\tLine content"
 *
 * The width of the number field is 6 chars (5 digits + 1 leading space minimum),
 * matching the observed format.
 */
function formatLines(
  lines: string[],
  startLine: number,
  endLine: number,
  totalLines: number
): string {
  const selected = lines.slice(startLine - 1, endLine);
  const numbered = selected.map((line, i) => {
    const lineNum = startLine + i;
    return `${String(lineNum).padStart(6)}\t${line}`;
  });
  return numbered.join("\n");
}

/**
 * Read a file as a string, replacing non-UTF-8 bytes with hex escapes
 * (e.g. \xFF), mirroring the view tool's binary file display.
 *
 * TextDecoder (fatal: false) already handles multi-byte sequences correctly,
 * emitting U+FFFD for each invalid byte. We walk the buffer and decoded string
 * in parallel: valid chars are copied as-is; each U+FFFD means the current
 * buffer byte was invalid, so we emit a hex escape and advance by one byte.
 */
function readFileWithHexEscapes(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!decoded.includes("\uFFFD")) return decoded;

  const encoder = new TextEncoder();
  let result = "";
  let bufPos = 0;
  for (const char of decoded) {
    if (char === "\uFFFD") {
      result += `\\x${buf[bufPos]!.toString(16).toUpperCase().padStart(2, "0")}`;
      bufPos += 1;
    } else {
      result += char;
      bufPos += encoder.encode(char).length;
    }
  }
  return result;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "file-tools-mcp-server",
  version: "1.0.0",
});

// ════════════════════════════════════════════════════════════════════════════
// TOOL 1: view
// ════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "view",
  {
    title: "View File or Directory",
    description: `Supports viewing text, images, and directory listings.

Supported path types:
- Directories: Lists files and directories up to 2 levels deep, ignoring hidden items and node_modules
- Image files (.jpg, .jpeg, .png, .gif, .webp): Displays the image visually
- Text files: Displays numbered lines (prefix \`    N\\t\` is display-only — do not include it in str_replace's \`old_str\`). You can optionally specify a view_range to see specific lines.

Note: Files with non-UTF-8 encoding will display hex escapes (e.g. \\x84) for invalid bytes`,
    inputSchema: {
      description: z
        .string()
        .describe("Why I need to view this file or directory. ALWAYS PROVIDE THIS PARAMETER FIRST."),
      path: z
        .string()
        .describe(
          "Absolute path to the file or directory, e.g. `/repo/file.py` or `/repo`."
        ),
      view_range: z
        .array(z.number().int())
        .length(2)
        .nullable()
        .optional()
        .describe(
          "Optional line range for text files. Format: [start_line, end_line] where lines are indexed starting at 1. Use [start_line, -1] to view from start_line to end of file. When not provided, the entire file is displayed."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (rawArgs) => {
    const filePath = (rawArgs as { path: string; view_range?: number[] | null }).path;
    const view_range = (rawArgs as { view_range?: number[] | null }).view_range as [number, number] | null | undefined;
    // Check existence
    if (!fs.existsSync(filePath)) {
      return {
        content: [
          { type: "text" as const, text: `Path not found: ${filePath}` },
        ],
        isError: true,
      };
    }

    const stat = fs.statSync(filePath);

    // ── Directory listing ──────────────────────────────────────────────────
    if (stat.isDirectory()) {
      const lines: string[] = [];
      buildDirListing(filePath, filePath, 0, lines);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }

    // ── File viewing ───────────────────────────────────────────────────────

    // Check if this is an image file — return as image content block
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const ext = path.extname(filePath).toLowerCase();
    if (imageExts.has(ext)) {
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const imageData = fs.readFileSync(filePath);
      const base64Data = imageData.toString('base64');
      const mediaType = mimeMap[ext] ?? 'image/png';
      return {
        content: [
          {
            type: 'image' as const,
            data: base64Data,
            mimeType: mediaType,
          },
        ],
      };
    }

    const raw = readFileWithHexEscapes(filePath);

    // Empty file
    if (raw === "") {
      return { content: [{ type: "text" as const, text: "" }] };
    }

    // Split into lines (preserve trailing newline as an empty final line)
    const lines = raw.split("\n");
    const totalLines = lines.length;

    // Handle view_range
    if (view_range) {
      let [startLine, endLine] = view_range;

      // Validate start
      if (startLine < 1 || startLine > totalLines) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid \`view_range\`: First element \`${startLine}\` should be between 1 and ${totalLines}`,
            },
          ],
          isError: true,
        };
      }

      // -1 means to end
      if (endLine === -1) endLine = totalLines;

      // Clamp end to totalLines
      if (endLine > totalLines) endLine = totalLines;

      const formatted = formatLines(lines, startLine, endLine, totalLines);
      return {
        content: [
          {
            type: "text" as const,
            text: `${formatted}\n[${totalLines} lines total]`,
          },
        ],
      };
    }

    // Full file view — check if truncation needed
    // We format all lines first, then measure chars
    const fullFormatted = formatLines(lines, 1, totalLines, totalLines);

    if (fullFormatted.length <= VIEW_CHAR_LIMIT) {
      return { content: [{ type: "text" as const, text: fullFormatted }] };
    }

    // Truncation: show beginning + tail, omit middle
    // Split the rendered output into rendered lines
    const renderedLines = fullFormatted.split("\n");
    const renderedTotal = renderedLines.length;

    // Build beginning until we hit half the budget
    const halfBudget = VIEW_CHAR_LIMIT / 2;
    let beginningEnd = 0;
    let charCount = 0;
    for (let i = 0; i < renderedTotal; i++) {
      charCount += renderedLines[i].length + 1; // +1 for \n
      if (charCount > halfBudget) break;
      beginningEnd = i + 1;
    }

    // Build tail from the end
    let tailStart = renderedTotal;
    charCount = 0;
    for (let i = renderedTotal - 1; i >= beginningEnd; i--) {
      charCount += renderedLines[i].length + 1;
      if (charCount > halfBudget) break;
      tailStart = i;
    }

    // Map rendered line indices back to original 1-based line numbers
    // Each rendered line corresponds to a file line (same index)
    const beginningContent = renderedLines.slice(0, beginningEnd).join("\n");
    const tailContent = renderedLines.slice(tailStart).join("\n");

    // The skipped file lines are beginningEnd+1 .. tailStart (1-based)
    const skipStart = beginningEnd + 1;
    const skipEnd = tailStart; // inclusive

    const truncationMarker = `\t< truncated lines ${skipStart}-${skipEnd} >`;

    const result = `${beginningContent}\n${truncationMarker}\n${tailContent}`;
    return { content: [{ type: "text" as const, text: result }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// TOOL 2: create_file
// ════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "create_file",
  {
    title: "Create New File",
    description: `Create a new file with content in the container`,
    inputSchema: {
      description: z
        .string()
        .describe(
          "Why I'm creating this file. ALWAYS PROVIDE THIS PARAMETER FIRST."
        ),
      path: z
        .string()
        .describe(
          "Absolute path to the file to create. ALWAYS PROVIDE THIS PARAMETER SECOND."
        ),
      file_text: z
        .string()
        .describe(
          "Content to write to the file. ALWAYS PROVIDE THIS PARAMETER LAST."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (rawArgs) => {
    const filePath = (rawArgs as { path: string; file_text: string }).path;
    const file_text = (rawArgs as { file_text: string }).file_text;
    // Refuse to overwrite
    if (fs.existsSync(filePath)) {
      return {
        content: [
          { type: "text" as const, text: `File already exists: ${filePath}` },
        ],
        isError: true,
      };
    }

    // Create parent directories
    const parentDir = path.dirname(filePath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }

    // Write file
    try {
      fs.writeFileSync(filePath, file_text, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `File created successfully: ${filePath}`,
        },
      ],
    };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// TOOL 3: str_replace
// ════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "str_replace",
  {
    title: "String Replace in File",
    description: `Replace a unique string in a file with another string. old_str must match the raw file content exactly and appear exactly once. When copying from view output, do NOT include the line number prefix (spaces + line number + tab) — it is display-only. View the file immediately before editing; after any successful str_replace, earlier view output of that file in your context is stale — re-view before further edits to the same file.`,
    inputSchema: {
      description: z.string().describe("Why I'm making this edit."),
      path: z.string().describe("Path to the file to edit."),
      old_str: z
        .string()
        .describe("String to replace (must be unique in file)."),
      new_str: z
        .string()
        .default("")
        .describe("String to replace with (empty to delete)."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (rawArgs) => {
    const filePath = (rawArgs as { path: string; old_str: string; new_str: string }).path;
    const old_str = (rawArgs as { old_str: string }).old_str;
    const new_str = (rawArgs as { new_str: string }).new_str ?? '';
    // File must exist
    if (!fs.existsSync(filePath)) {
      return {
        content: [
          { type: "text" as const, text: `File not found: ${filePath}` },
        ],
        isError: true,
      };
    }

    const content = fs.readFileSync(filePath, "utf8");

    // Count occurrences (non-overlapping)
    const occurrences = content.split(old_str).length - 1;

    if (occurrences === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `String to replace not found in ${filePath}. ` +
              `Use the view tool to see the current file content before retrying. ` +
              `If you made a successful str_replace to this file since your last view, ` +
              `that edit invalidated your view output.`,
          },
        ],
        isError: true,
      };
    }

    if (occurrences > 1) {
      return {
        content: [
          {
            type: "text" as const,
            text: `String to replace found multiple times, must be unique`,
          },
        ],
        isError: true,
      };
    }

    // Replace exactly once — use split/join to avoid String.replace() interpreting
    // special patterns like $&, $`, $', $1 in new_str.
    const newContent = content.split(old_str).join(new_str);

    try {
      fs.writeFileSync(filePath, newContent, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully replaced string in ${filePath}`,
        },
      ],
    };
  }
);


// ════════════════════════════════════════════════════════════════════════════
// TOOL 4: bash_tool
// ════════════════════════════════════════════════════════════════════════════

server.registerTool(
  'bash_tool',
  {
    title: 'Run Bash Command',
    description: `Run a bash command in the container`,
    inputSchema: {
      command: z.string().describe('Bash command to run'),
      description: z.string().describe('Why I am running this command'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (rawArgs) => {
    const command = (rawArgs as { command: string }).command;

    const result = await new Promise<{ returncode: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFileCallback(
          'bash',
          ['-c', command],
          { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024, cwd: '/' },
          (error: ExecFileException | null, stdoutBuf: Buffer, stderrBuf: Buffer) => {
            const returncode =
              error && 'code' in error && typeof error.code === 'number'
                ? error.code
                : 0;
            const stdout = stdoutBuf.toString('utf8');
            const stderr = stderrBuf.toString('utf8');
            resolve({ returncode, stdout, stderr });
          }
        );
      }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

// ─── Transport Setup ─────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("file-tools-mcp-server running on stdio");
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    console.error(`file-tools-mcp-server running on http://localhost:${port}/mcp`);
  });
}

const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHTTP().catch((error: unknown) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error: unknown) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}