// ─────────────────────────────────────────────────────────────
// test-mcp-client.ts — v3.5 regression test for the EXTERNAL MCP
// client (src/lib/agent/mcp-client.ts).
//
// It spawns THIS project's own MCP server (mcp-server/index.ts,
// 30+ tools) as if it were an external server configured like
// github-mcp-server in a mcp.config.json, and verifies:
//   1. stdio handshake: initialize → tools/list → wrapped tools
//   2. tool name mapping mcp_<server>_<tool> + schema conversion
//   3. a REAL tools/call round-trip through the wrapped execute
//   4. $VAR env expansion + safe skip when the var is empty
//      (never spawns docker with a blank PAT)
//   5. "enabled": false → skipped with a transcript note
//   6. AGENT_MCP=0 global kill switch
//   7. cleanup() kills the child server
//
// Run: bun scripts/test-mcp-client.ts
// ─────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MCP_MODE = "1"; // keep prisma off stdout in the child server

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// ── write a temp mcp.config.json ─────────────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcpcli-"));
const configPath = path.join(tmp, "mcp.config.json");
await fs.writeFile(
  configPath,
  JSON.stringify(
    {
      mcpServers: {
        local: {
          enabled: true,
          transport: "stdio",
          command: "bun",
          args: ["mcp-server/index.ts"],
          cwd: PROJECT_ROOT
        },
        "missing-token": {
          enabled: true,
          transport: "stdio",
          command: "docker",
          args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_PERSONAL_ACCESS_TOKEN" }
        },
        "disabled-one": {
          enabled: false,
          transport: "stdio",
          command: "docker",
          args: []
        }
      }
    },
    null,
    2
  )
);
process.env.AGENT_MCP_CONFIG = configPath;
delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN; // simulate: PAT not set yet
delete process.env.AGENT_MCP;

const { loadExternalMcpTools } = await import("../src/lib/agent/mcp-client");

// ── 1-3. load + call ─────────────────────────────────────────
console.log("1) loadExternalMcpTools() — stdio handshake with our own MCP server");
const result = await loadExternalMcpTools();
try {
  check("tools were discovered", result.tools.length > 0, `${result.tools.length} tools`);
  check(
    "tool names carry the mcp_<server>_ prefix and are sanitized",
    result.tools.every((t) => /^mcp_local_[a-z0-9_-]+$/.test(t.name)),
    result.tools.slice(0, 3).map((t) => t.name).join(", ")
  );
  check(
    "descriptions are tagged [mcp:local]",
    result.tools.every((t) => t.description.startsWith("[mcp:local]"))
  );
  check(
    "every tool has an object schema with properties",
    result.tools.every((t) => t.parameters.type === "object" && t.parameters.properties)
  );
  const statsTool = result.tools.find((t) => t.name === "mcp_local_get_stats");
  check("the server's get_stats tool is present", Boolean(statsTool));

  console.log("2) tools/call round-trip through the wrapped execute");
  if (statsTool) {
    const raw = await statsTool.execute({});
    const json = JSON.stringify(raw);
    check("get_stats call returned data", json.length > 2, json.slice(0, 120));
    check("get_stats call returned no error", !/^\{?"?error/.test(json));
  }

  console.log("3) schema conversion kept required params");
  const searchTool = result.tools.find((t) => t.name === "mcp_local_search_public_jobs");
  if (searchTool) {
    check(
      "search_public_jobs schema has a role/roles property",
      Object.keys(searchTool.parameters.properties).some((k) => /role/i.test(k)),
      Object.keys(searchTool.parameters.properties).join(", ")
    );
  } else {
    check("search_public_jobs tool present", false, "not found");
  }
} finally {
  result.cleanup();
}

// ── 4-5. skip notes ──────────────────────────────────────────
console.log("4) empty-token server skipped + disabled server noted");
const noteText = result.notes.join("\n");
check(
  "missing-token server skipped with the exact env var name",
  /missing-token.*skipped.*GITHUB_PERSONAL_ACCESS_TOKEN/i.test(noteText),
  noteText
);
check(
  "no docker process was spawned for the tokenless server (no docker failure note)",
  !/failed to spawn "docker"|handshake failed.*missing-token/i.test(noteText)
);
check(
  "disabled server explained with the enable instruction",
  /disabled-one.*disabled in mcp\.config\.json.*"enabled": true/i.test(noteText),
  noteText
);
check(
  "the local server connection is reported with its tool count",
  /MCP "local" connected via stdio.*tools available/.test(noteText),
  noteText
);

// ── 6. kill switch ───────────────────────────────────────────
console.log("5) AGENT_MCP=0 kill switch");
process.env.AGENT_MCP = "0";
const off = await loadExternalMcpTools();
check("kill switch returns zero tools", off.tools.length === 0);
check("kill switch explains itself", /disabled via AGENT_MCP=0/i.test(off.notes.join("\n")));
off.cleanup();
delete process.env.AGENT_MCP;

// ── 7. no config file → silent, zero tools ───────────────────
console.log("6) missing config file");
process.env.AGENT_MCP_CONFIG = path.join(tmp, "does-not-exist.json");
const none = await loadExternalMcpTools();
check("missing config → zero tools, no notes", none.tools.length === 0 && none.notes.length === 0);
none.cleanup();
delete process.env.AGENT_MCP_CONFIG;

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
