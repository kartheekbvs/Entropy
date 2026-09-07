import { PrismaClient } from '@prisma/client'

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