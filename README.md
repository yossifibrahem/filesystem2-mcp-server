# file-tools-mcp-server

An MCP server that faithfully replicates Claude's three built-in computer-use tools — **`view`**, **`create_file`**, and **`str_replace`** — as standard MCP tools any LLM client can call.

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
    "file-tools": {
      "command": "node",
      "args": ["/absolute/path/to/file-tools-mcp-server/dist/index.js"]
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
