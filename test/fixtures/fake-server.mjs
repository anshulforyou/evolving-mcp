// A deliberately awkward MCP-ish server, so the proxy can be tested against
// framing it will really meet: several messages in one write, one message
// split across writes, embedded newlines, a large payload, out-of-order
// replies, notifications, and a JSON-RPC error.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function handle(msg) {
  if (msg.id === undefined) return; // notification, no reply
  const name = msg.params?.name;
  if (name === "slow") {
    // Replies after the next request, so responses arrive out of order.
    setTimeout(() => write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "slow done" }] } }), 60);
    return;
  }
  if (name === "boom") {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "exploded" } });
    return;
  }
  if (name === "newlines") {
    write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "a\nb\nc" }] } });
    return;
  }
  if (name === "big") {
    write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "x".repeat(200000) }] } });
    return;
  }
  if (name === "burst") {
    // Two complete messages in a single write.
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "burst" }] } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }) +
        "\n",
    );
    return;
  }
  write({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `ok:${name ?? msg.method}` }], structuredContent: [{ v: 1 }] } });
}
