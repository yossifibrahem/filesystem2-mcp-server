# computer-use-mcp-server

An MCP server that faithfully replicates Claude's four built-in computer-use tools — **`view`**, **`create_file`**, **`str_replace`**, and **`bash_tool`** — as standard MCP tools any LLM client can call.

Reverse-engineered from live tool behaviour, verified with a 57-test suite (0 failures).

---

## Tools

### `view`
Read a file or list a directory.

| Feature | Detail |
|---|---|
| Line numbers | `     N\tline content` (6-char right-padded) |
| Empty file | Returns empty string, no error |
| Binary / non-UTF-8 | Bytes shown as `\xFF` hex escapes |
| Large files | Middle truncated; shows `< truncated lines X-Y >` |
| `view_range` | `[start, end]` (1-based, end=-1 means EOF) |
| Directories | 2-level deep; hides hidden files & `node_modules` |

**Arguments**

| Param | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | Reason for viewing (context only, not written to disk) |
| `path` | string | ✅ | Absolute path to file or directory |
| `view_range` | `[number, number]` | ❌ | Line range (1-based, -1 for EOF) |

---

### `create_file`
Create a new file. Refuses to overwrite existing files.

**Arguments**

| Param | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | Reason for creating (not written to disk) |
| `path` | string | ✅ | Absolute destination path |
| `file_text` | string | ✅ | Exact content to write |

---

### `str_replace`
Replace a unique string in a file. Fails if the string appears 0 or 2+ times.

**Arguments**

| Param | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | Reason for edit (not written to disk) |
| `path` | string | ✅ | Absolute path to the file |
| `old_str` | string | ✅ | Exact string to find (must appear exactly once) |
| `new_str` | string | ❌ | Replacement (defaults to `""` — deletes `old_str`) |

---

### `bash_tool`
Run a bash command and return its stdout, stderr, and exit code.

**Arguments**

| Param | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✅ | The bash script to execute |
| `description` | string | ✅ | Reason for running (context only, not executed) |

**Returns**

A JSON object with three fields:

```json
{
  "returncode": 0,
  "stdout": "...",
  "stderr": "..."
}
```

| Field | Type | Description |
|---|---|---|
| `returncode` | number | Exit code (0 = success) |
| `stdout` | string | Everything written to stdout |
| `stderr` | string | Everything written to stderr |

**Behaviour**

- Each call is a **fresh bash process** — environment variables, working directory, and shell state do **not** persist between calls
- stdout and stderr are captured separately and returned in full (no truncation; up to 100 MB buffer)
- Supports multi-line commands, pipes, subshells, heredocs, and all standard bash features
- Binary output is returned as-is; UTF-8 Unicode is supported natively

**What does NOT persist between calls**

- Environment variables set with `export`
- Working directory changes (`cd`)
- Shell functions or aliases defined in a previous call

---

## Usage

### stdio (default)
```bash
npm install
npm run build
node dist/index.js
```

### HTTP
```bash
TRANSPORT=http PORT=3000 node dist/index.js
# POST requests to http://localhost:3000/mcp
```

### Claude Desktop config (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/absolute/path/to/computer-use-mcp-server/dist/index.js"]
    }
  }
}
```

---

## Edge Cases Handled

| Scenario | Behaviour |
|---|---|
| `create_file` on existing path | Error: `File already exists: <path>` |
| `view` on missing path | Error: `Path not found: <path>` |
| `str_replace` on missing file | Error: `File not found: <path>` |
| `str_replace` — string not found | Error with hint to re-view the file |
| `str_replace` — string found 2+ times | Error: must be unique |
| `view_range` start out of bounds | Error: `Invalid \`view_range\`: First element...` |
| `view_range` end beyond EOF | Clamped silently to last line |
| Large file (>16 000 chars) | Truncated with `< truncated lines X-Y >` marker |
| Hidden files / `node_modules` in dirs | Excluded from directory listing |
| Binary files | Non-UTF-8 bytes shown as `\xFF` hex escapes |

---

## Development

```bash
npm install        # install deps
npm run build      # compile TypeScript → dist/
node test_mcp.mjs  # run 57-test suite (copy from repo root)
```