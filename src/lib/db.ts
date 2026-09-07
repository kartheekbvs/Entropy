import { existsSync } from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

// ─────────────────────────────────────────────────────────────
// v5.2 — CROSS-PLATFORM DATABASE URL RESOLUTION
//
// WHY: Prisma + SQLite + `file:./db/custom.db` is a portability
// trap. Relative file: URLs resolve against whatever the CLI or
// engine considers its base dir, and the standalone production
// server does `process.chdir(__dirname)` (.next/standalone!) —
// so on a Windows/mac/linux laptop the app would look for the
// database inside the build folder, find nothing, and EVERY
// query would fail (runs never save, "files are not creating").
//
// FIX: resolve the URL to an ABSOLUTE path, in this priority:
//   1. Already absolute → untouched
//   2. ENTROPY_PROJECT_ROOT (set by scripts/server.js launcher)
//   3. Walk up from cwd until a dir containing package.json +
//      prisma/schema.prisma (or the db file itself) is found —
//      covers dev mode, standalone server, and the zip install
//   4. process.cwd() as the last resort
// Separators are normalized to forward slashes, which Node,
// Prisma and the SQLite engine all accept on every platform
// (including Windows).
// ─────────────────────────────────────────────────────────────
function resolveDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw
  if (!raw.startsWith('file:')) return raw

  let rel = raw.slice('file:'.length)
  // strip the query part Prisma allows (?connection_limit=…)
  const qIdx = rel.indexOf('?')
  const query = qIdx >= 0 ? rel.slice(qIdx) : ''
  if (qIdx >= 0) rel = rel.slice(0, qIdx)

  const norm = rel.replace(/\\/g, '/')
  if (path.isAbsolute(norm) || /^[a-zA-Z]:\//.test(norm)) {
    return `file:${norm}${query}` // already absolute (win or posix)
  }

  const anchors = [norm.split('/')[0] || 'db', 'prisma']
  const isProjectDir = (d: string): boolean => {
    try {
      const hasPkg = existsSync(path.join(d, 'package.json'))
      const hasAnchor = anchors.some((a) => existsSync(path.join(d, a)))
      return hasPkg && hasAnchor
    } catch {
      return false
    }
  }

  const root =
    (process.env.ENTROPY_PROJECT_ROOT && process.env.ENTROPY_PROJECT_ROOT.trim()
      ? path.resolve(process.env.ENTROPY_PROJECT_ROOT.trim())
      : null) ??
    (isProjectDir(process.cwd())
      ? process.cwd()
      : (() => {
          // walk up from cwd (standalone server chdir's into .next/standalone)
          let cur = process.cwd()
          for (let i = 0; i < 8; i++) {
            const parent = path.dirname(cur)
            if (parent === cur) break
            cur = parent
            if (isProjectDir(cur)) return cur
          }
          return process.cwd()
        })())

  const abs = path.resolve(root, norm).replace(/\\/g, '/')
  return `file:${abs}${query}`
}

const resolved = resolveDatabaseUrl(process.env.DATABASE_URL)
if (resolved && resolved !== process.env.DATABASE_URL) {
  // PrismaClient reads DATABASE_URL at construction time — mutate BEFORE
  // the client below is instantiated (module top-level, once per process).
  process.env.DATABASE_URL = resolved
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // MCP_MODE=1 keeps stdout clean for the JSON-RPC channel (see mcp-server/index.ts)
    log: process.env.MCP_MODE === "1" ? ['error'] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
