/**
 * Minimal MCP stdio client, used only to record a corpus.
 *
 * This deliberately speaks the older 2024-11-05 handshake, because the
 * reference servers we record against still do. evolving-mcp itself targets
 * 2026-07-28. This file is test instrumentation, not part of the product, and
 * nothing downstream of the corpus depends on the wire version.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Json } from "../types.js";

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, Json>;
}

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
}

export class StdioMcpClient {
  private proc: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private stderr = "";

  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c: string) => this.onData(c));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c: string) => {
      this.stderr += c;
    });
    this.proc.on("exit", (code) => {
      const err = new Error(
        `mcp server exited (${code}). stderr tail:\n${this.stderr.slice(-800)}`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, Json>;
      try {
        msg = JSON.parse(line) as Record<string, Json>;
      } catch {
        continue; // servers sometimes emit non-JSON noise on stdout
      }
      const id = msg["id"];
      if (typeof id !== "number") continue;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (msg["error"]) p.reject(new Error(JSON.stringify(msg["error"])));
      else p.resolve((msg["result"] ?? null) as Json);
    }
  }

  private send(method: string, params: Json, expectReply: true): Promise<Json>;
  private send(method: string, params: Json, expectReply: false): Promise<void>;
  private send(method: string, params: Json, expectReply: boolean): Promise<Json | void> {
    const frame: Record<string, Json> = { jsonrpc: "2.0", method, params };
    if (!expectReply) {
      this.proc.stdin.write(JSON.stringify(frame) + "\n");
      return Promise.resolve();
    }
    const id = this.nextId++;
    frame["id"] = id;
    const done = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(JSON.stringify(frame) + "\n");
    return done;
  }

  async initialize(): Promise<void> {
    await this.send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "evolving-mcp-recorder", version: "0" },
      },
      true,
    );
    await this.send("notifications/initialized", {}, false);
  }

  async listTools(): Promise<ToolDef[]> {
    const r = (await this.send("tools/list", {}, true)) as unknown as { tools: ToolDef[] };
    return r.tools;
  }

  /** Returns the raw result payload, exactly as a caller would receive it. */
  async callTool(name: string, args: Json): Promise<Json> {
    return this.send("tools/call", { name, arguments: args }, true);
  }

  close(): void {
    this.proc.stdin.end();
    this.proc.kill();
  }
}
