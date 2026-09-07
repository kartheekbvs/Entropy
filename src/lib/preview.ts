// ─────────────────────────────────────────────────────────────
// v4.7 PREVIEW LIB — the engine behind the Replit-style Live
// Preview Studio.
//
// The idea (straight from the user's Replit screenshot): when the
// agent creates an app, you SEE it — running, live, right inside
// the Job Hunt Command Center, auto-refreshing as the agent
// writes files, with a browser console underneath.
//
// This module is deliberately dependency-free and isomorphic
// (string + pure-data helpers only), so the API routes and the
// client components import the same source of truth:
//
//   • PREVIEW_CHANNEL / publishPreviewWrite — every agent file
//     write publishes here; /api/preview/events fans it out to
//     every open webview over SSE in ~0 ms (the 1.5 s signature
//     poll in the events route is only the safety net for
//     writes made outside the agent, e.g. by hand or by shell).
//   • injectPreviewRuntime() — the magic served with every HTML
//     entry: a <base> tag so relative assets resolve, a console
//     forwarder (log/warn/error → the Studio's console panel),
//     window.onerror + unhandledrejection capture, a storage
//     polyfill (sandboxed frames throw on real localStorage),
//     and an EventSource live-reload listener. One script, the
//     whole Replit webview behaviour, ~1.5 KB.
//   • collectPreviewEntries / bestPreviewEntry — "what can be
//     previewed": every .html page in the workspace, index.html
//     apps first, newest work highlighted.
// ─────────────────────────────────────────────────────────────

import { publish } from "@/lib/agent/event-bus";

/** SSE channel shared by the agent tools, the events route and the studio. */
export const PREVIEW_CHANNEL = "preview";

/** Marker injected into served HTML (also the double-injection guard). */
const RUNTIME_MARKER = "/*__JCC_PREVIEW_RUNTIME__*/";

/**
 * Announce a workspace file write on the preview channel.
 * Called from the coding tools (fs_write / fs_edit / fs_batch /
 * fs_copy / fs_move) — never throws, never blocks the agent.
 */
export function publishPreviewWrite(path: string): void {
  try {
    publish(PREVIEW_CHANNEL, "write", { data: { path, ts: Date.now() } });
  } catch {
    /* the preview must never break the agent loop */
  }
}

// ── Live-reload runtime (injected into every served HTML) ────

/** Directory part of a POSIX rel path, WITH trailing slash ("" for root). */
export function previewDirOf(p: string): string {
  const s = String(p ?? "");
  const i = s.lastIndexOf("/");
  return i < 0 ? "" : s.slice(0, i + 1);
}

/**
 * Is a written file relevant to a previewed entry?
 * true when it IS the entry, lives in the entry's subtree, or is a
 * shared ancestor-dir asset (styles/global.css referenced via ../).
 */
export function previewRelevant(entry: string, written: string): boolean {
  if (!written) return true;
  if (written === entry) return true;
  const a = previewDirOf(written);
  const b = previewDirOf(entry);
  if (a === b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Build the runtime script injected into previewed HTML pages.
 * Self-contained ES5 so it also runs in the standalone new-tab view.
 */
function runtimeScript(entry: string): string {
  const safeEntry = String(entry).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `(function(){${RUNTIME_MARKER}
var ENTRY="${safeEntry}";
function dirOf(p){p=String(p||"");var i=p.lastIndexOf("/");return i<0?"":p.slice(0,i+1);}
function rel(w){if(!w)return true;if(w===ENTRY)return true;var a=dirOf(w),b=dirOf(ENTRY);if(a===b)return true;return a.indexOf(b)===0||b.indexOf(a)===0;}
function fmt(x){if(typeof x==="string")return x;try{return JSON.stringify(x)}catch(e){try{return String(x)}catch(e2){return"?"}}}
function post(level,args){try{parent.postMessage({__jccPreview:1,type:"console",level:level,text:args.map(fmt).join(" "),ts:Date.now()},"*")}catch(e){}}
["log","info","warn","error"].forEach(function(m){
var orig;try{orig=console[m]?console[m].bind(console):function(){}}catch(e){orig=function(){}}
console[m]=function(){var a=[].slice.call(arguments);try{orig.apply(null,a)}catch(e){}post(m,a);};});
window.addEventListener("error",function(e){
var msg=(e&&e.message)?e.message:"Script error";
var loc=(e&&e.filename)?(" ("+String(e.filename).split("/").pop()+":"+(e.lineno||0)+")"):"";
post("error",[msg+loc]);});
window.addEventListener("unhandledrejection",function(e){
var r=e&&e.reason;post("error",["Unhandled rejection: "+((r&&r.message)?r.message:fmt(r))]);});
["localStorage","sessionStorage"].forEach(function(name){
try{window[name].getItem("__jcc_probe__")}catch(e){
var store={};var shim={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(store,k)?store[k]:null},
setItem:function(k,v){store[String(k)]=String(v)},removeItem:function(k){delete store[String(k)]},
clear:function(){store={}},key:function(i){return Object.keys(store)[i]||null}};
Object.defineProperty(shim,"length",{get:function(){return Object.keys(store).length}});
try{Object.defineProperty(window,name,{value:shim,configurable:true})}catch(e2){}}});
try{var es=new EventSource("/api/preview/events");
es.addEventListener("write",function(ev){try{var d=ev.data?JSON.parse(ev.data):{};if(rel(d.path)){location.reload()}}catch(e){location.reload()}});
}catch(e){}
try{parent.postMessage({__jccPreview:1,type:"ready",path:ENTRY,ts:Date.now()},"*")}catch(e){}
})();`;
}

/**
 * Inject the preview runtime into an HTML document:
 *   1. <base href> so RELATIVE AND root-absolute asset URLs resolve
 *      against the entry's directory inside /api/preview/
 *   2. the console-forwarder + storage-polyfill + live-reload script
 * Idempotent (the runtime marker guards double injection) and safe
 * for documents without <head>/<html> tags.
 */
export function injectPreviewRuntime(html: string, entry: string): string {
  const doc = String(html ?? "");
  if (doc.includes(RUNTIME_MARKER)) return doc; // already injected
  const dir = previewDirOf(entry);
  const inject =
    `<base href="/api/preview/${dir}">\n` +
    `<script>${runtimeScript(entry)}</script>\n`;
  // best spot: immediately after the opening <head> so the base tag
  // precedes every stylesheet/script the app declares
  const headOpen = /<head[^>]*>/i.exec(doc);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return doc.slice(0, at) + "\n" + inject + doc.slice(at);
  }
  const headClose = /<\/head\s*>/i.exec(doc);
  if (headClose) {
    const at = headClose.index;
    return doc.slice(0, at) + inject + doc.slice(at);
  }
  const htmlOpen = /<html[^>]*>/i.exec(doc);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return doc.slice(0, at) + "\n" + inject + doc.slice(at);
  }
  return inject + doc;
}

// ── Entry detection (isomorphic, works on tree JSON) ─────────

export interface PreviewEntry {
  /** Workspace-relative POSIX path, e.g. "frontend/index.html". */
  path: string;
  name: string;
  dir: string;
  mtime: number;
  size: number;
}

interface LiteNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  children?: LiteNode[];
}

export function isPreviewableFile(name: string): boolean {
  return /\.(html?|svg)$/i.test(name);
}

/**
 * Every previewable page in the workspace tree.
 * Order: index.html app entries first (shallow → deep), then every
 * other .html page newest-first. .svg files are viewable too and
 * come last.
 */
export function collectPreviewEntries(nodes: LiteNode[]): PreviewEntry[] {
  const pages: PreviewEntry[] = [];
  const svgs: PreviewEntry[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as LiteNode;
    if (n.type === "file") {
      if (/\.html?$/i.test(n.name)) {
        pages.push({ path: n.path, name: n.name, dir: previewDirOf(n.path), mtime: n.mtime, size: n.size });
      } else if (/\.svg$/i.test(n.name)) {
        svgs.push({ path: n.path, name: n.name, dir: previewDirOf(n.path), mtime: n.mtime, size: n.size });
      }
    } else if (n.children) {
      stack.push(...n.children);
    }
  }
  const isIndex = (e: PreviewEntry) => /^index\.html?$/i.test(e.name);
  const depth = (e: PreviewEntry) => e.path.split("/").length;
  pages.sort((a, b) => {
    const ia = isIndex(a) ? 0 : 1;
    const ib = isIndex(b) ? 0 : 1;
    if (ia !== ib) return ia - ib; // index.html apps first
    if (ia === 0 && depth(a) !== depth(b)) return depth(a) - depth(b); // shallower roots first
    return b.mtime - a.mtime; // freshest work on top
  });
  svgs.sort((a, b) => b.mtime - a.mtime);
  return [...pages, ...svgs];
}

/** The entry the studio opens by default (first of collectPreviewEntries). */
export function bestPreviewEntry(nodes: LiteNode[]): PreviewEntry | null {
  const entries = collectPreviewEntries(nodes);
  return entries.length > 0 ? entries[0] : null;
}
