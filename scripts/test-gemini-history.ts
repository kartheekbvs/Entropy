// ─────────────────────────────────────────────────────────────
// test-gemini-history.ts — regression test for the v3.4 bug that
// made the agent quit after ONE tool call (~1 minute):
//
//   "Gemini request error — HTTP 400: { … 'message': 'Function call
//    is missing a thought_signature in functionCall parts …' }"
//
// ROOT CAUSE: Gemini 2.5 thinking models attach a thoughtSignature
// to every function-call part and the API REFUSES the next request
// unless those parts are replayed verbatim. The old history mapper
// reconstructed parts from {name, args} only — silently dropping
// the signature → every multi-turn Gemini run died at turn 2.
//
// This suite pins the wire-format guarantees:
//   1. rawParts turns replay EXACTLY (signatures survive)
//   2. reconstructed turns replay per-call signatures when present
//   3. thought-summary parts are stripped on replay
//   4. tool-result turns map to functionResponse parts
//   5. compactHistoryToText produces NO function-call parts at all
//      (the 400-recovery path) and keeps the goal + tool results
// Run: bun scripts/test-gemini-history.ts
// ─────────────────────────────────────────────────────────────
import {
  historyToGemini,
  compactHistoryToText,
  repairMissingClosers,
  parseProtocol,
  type HistoryTurn,
} from "../src/lib/agent/llm";

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

console.log("test-gemini-history — thought-signature replay (the 1-minute-agent bug)\n");

// ── Section 1: rawParts verbatim replay ──────────────────────
console.log("[1] rawParts (exact Gemini parts) replay");

// What Gemini 2.5 Flash actually returns for a tool-call turn:
// a thought summary part + a signed function-call part.
const signedParts = [
  { text: "I should inspect the workspace first.", thought: true },
  {
    thoughtSignature: "CqQBGkDk4n4K",
    functionCall: { name: "workspace_info", args: {} },
  },
  { text: "Checking the environment." },
];

const historyRaw: HistoryTurn[] = [
  { role: "user", text: "Build the dashboard app." },
  { role: "model", text: undefined, toolCalls: [{ name: "workspace_info", args: {} }], rawParts: signedParts },
  { role: "toolResults", results: [{ name: "workspace_info", result: { files: 1 } }] },
];

let contents = historyToGemini(historyRaw);
check("3 turns → 3 contents", contents.length === 3, `got ${contents.length}`);
const modelTurn = contents[1];
check("model turn preserved", modelTurn?.role === "model");

const fcPart = modelTurn?.parts.find((p) => p.functionCall);
check(
  "function-call part replays thoughtSignature VERBATIM",
  fcPart?.thoughtSignature === "CqQBGkDk4n4K",
  `got ${JSON.stringify(fcPart).slice(0, 120)}`
);
check(
  "function name/args intact",
  fcPart?.functionCall?.name === "workspace_info" && fcPart?.functionCall?.args !== undefined
);
check(
  "thought-summary parts are stripped on replay",
  !modelTurn?.parts.some((p) => p.thought === true && p.text !== undefined && p.functionCall === undefined)
);
check(
  "normal text parts kept",
  modelTurn?.parts.some((p) => p.text === "Checking the environment.")
);

const frPart = contents[2]?.parts.find((p) => p.functionResponse);
check(
  "tool results → functionResponse parts",
  frPart?.functionResponse?.name === "workspace_info" && frPart !== undefined,
);

// ── Section 2: reconstructed history (rawParts absent) ───────
console.log("\n[2] reconstructed history — per-call signature fallback");
const historyReconstructed: HistoryTurn[] = [
  { role: "user", text: "Build the dashboard app." },
  {
    role: "model",
    toolCalls: [{ name: "fs_write", args: { path: "a.js" }, thoughtSignature: "SIGabc" }],
  },
  { role: "toolResults", results: [{ name: "fs_write", result: { bytes: 10 } }] },
];
contents = historyToGemini(historyReconstructed);
const recFc = contents[1]?.parts.find((p) => p.functionCall);
check(
  "reconstructed call carries its thoughtSignature",
  recFc?.thoughtSignature === "SIGabc",
  `got ${JSON.stringify(recFc).slice(0, 120)}`
);
check(
  "calls WITHOUT a signature replay without the field (not undefined-valued)",
  (() => {
    const c2 = historyToGemini([
      { role: "user", text: "x" },
      { role: "model", toolCalls: [{ name: "fs_list", args: {} }] },
    ])[1]?.parts.find((p) => p.functionCall);
    return c2 !== undefined && c2?.thoughtSignature === undefined;
  })()
);

// ── Section 3: multi-call turn keeps every signature ─────────
console.log("\n[3] multi-tool-call turns");
const multiParts = [
  { thoughtSignature: "S1", functionCall: { name: "fs_write", args: { path: "1.js" } } },
  { thoughtSignature: "S2", functionCall: { name: "fs_write", args: { path: "2.js" } } },
];
contents = historyToGemini([
  { role: "user", text: "go" },
  { role: "model", toolCalls: multiParts.map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args as Record<string, unknown> })), rawParts: multiParts },
]);
const sigs = contents[1]?.parts.map((p) => p.thoughtSignature);
check(
  "each signed part replays its OWN signature in order",
  JSON.stringify(sigs) === JSON.stringify(["S1", "S2"]),
  `got ${JSON.stringify(sigs)}`
);

// ── Section 4: emergency text compaction (400 recovery) ──────
console.log("\n[4] compactHistoryToText — the 400-recovery path");
const compacted = compactHistoryToText(historyRaw);
check("compacted history is a single user turn", compacted.length === 1 && compacted[0]?.role === "user");
const compactText = (compacted[0] as { text: string }).text;
check("goal text survives compaction", compactText.includes("Build the dashboard app."));
check("tool results survive compaction", compactText.includes("workspace_info") && compactText.includes("files"));
check(
  "no function-call parts anywhere (no signature requirement)",
  (() => {
    const c = historyToGemini(compacted);
    return c.length === 1 && c[0]?.role === "user" && c[0]?.parts.every((p) => p.functionCall === undefined);
  })()
);
check(
  "model is told the tools already ran (continues, not restarts)",
  /ALREADY EXECUTED/i.test(compactText)
);

// ── Section 5: empty edge cases ──────────────────────────────
console.log("\n[5] edge cases");
contents = historyToGemini([{ role: "user", text: "hi" }, { role: "model", text: undefined }]);
check(
  "empty model turn gets a placeholder text part (API rejects empty parts arrays)",
  (contents[1]?.parts.length ?? 0) > 0
);
contents = historyToGemini([
  { role: "user", text: "hi" },
  { role: "model", text: "hello", rawParts: [{ text: "thinking…", thought: true }] },
]);
check(
  "rawParts with ONLY thought summaries falls back to a placeholder",
  (contents[1]?.parts.length ?? 0) > 0 && !contents[1]?.parts.some((p) => p.thought === true)
);

// ── Section 6: the missing-root-brace repair (z-ai live bug) ──
console.log("\n[6] missing-closer repair — the live z-ai fs_write defect");
// EXACT shape captured live (finish=stop, 633 chars): complete tool call
// whose final ROOT brace the model dropped. Old parser → "truncation"
// nudge loop ×6 → hallucinated final report with zero files written.
// Shape: ...content":"{...}" + } (args closed) — root never closed.
const brokenFsWrite =
  '{"tool":"fs_write","args":{"path":"dashboard/data.json","content":"{\\n  \\"salesData\\": {\\n    \\"labels\\": [\\"Jan\\", \\"Feb\\"],\\n    \\"values\\": [12000, 19000]\\n  }\\n}"';

const repaired = repairMissingClosers(brokenFsWrite);
check(
  "repair appends ALL missing closers (args + root here → '}}')",
  repaired === brokenFsWrite + "}}",
  `got ${JSON.stringify(repaired?.slice(-4))}`
);
const liveShape =
  '{"tool":"fs_write","args":{"path":"d/i.html","content":"<html>\\n</html>"}';
check("live-captured shape (args closed, root missing) gets exactly one brace", repairMissingClosers(liveShape) === liveShape + "}");
check("repair does not touch balanced JSON", repairMissingClosers('{"tool":"x","args":{}}') === '{"tool":"x","args":{}}');
check(
  "unclosed STRING is NOT repaired (that is real truncation)",
  repairMissingClosers('{"tool":"x","args":{"content":"unclosed') === null
);
check(
  "mismatched closers are NOT repaired",
  repairMissingClosers('{"tool":"x","args":{}]') === null
);

const protoBroken = parseProtocol(brokenFsWrite);
check(
  "parseProtocol now EXTRACTS the tool call (previously: false truncation)",
  protoBroken.toolCalls?.length === 1 && protoBroken.toolCalls[0]?.name === "fs_write",
  `got ${JSON.stringify(protoBroken).slice(0, 120)}`
);
check(
  "extracted args decode the file content correctly (newlines, quotes)",
  (() => {
    const content = protoBroken.toolCalls?.[0]?.args?.content as string | undefined;
    return content === '{\n  "salesData": {\n    "labels": ["Jan", "Feb"],\n    "values": [12000, 19000]\n  }\n}';
  })()
);
check("no false truncation flag when repair succeeds", protoBroken.truncatedToolCall === undefined);
check(
  "REAL truncation (string cut mid-content) still flags truncatedToolCall",
  (() => {
    const p = parseProtocol('{"tool":"fs_write","args":{"path":"a.js","content":"line1\\nline2');
    return p.truncatedToolCall !== undefined && p.toolCalls === undefined;
  })()
);
check(
  "concatenated calls with a brace-dropped LAST call all extract",
  (() => {
    const two = '{"tool":"fs_mkdir","args":{"path":"d"}}{"tool":"fs_write","args":{"path":"d/a.js","content":"x"';
    const p = parseProtocol(two);
    return p.toolCalls?.length === 2 && p.toolCalls[1]?.name === "fs_write";
  })()
);

// ── Result ───────────────────────────────────────────────────
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("FAILURES PRESENT — the thought-signature replay is broken");
  process.exit(1);
}
console.log("The exact bug that killed the user's run (HTTP 400 missing thought_signature) is covered.");
