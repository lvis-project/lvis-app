import net from "node:net";

const targetHost = process.env.MARKETPLACE_UPSTREAM_HOST;
const targetPort = Number(process.env.MARKETPLACE_UPSTREAM_PORT);
if (targetHost !== "marketplace" || targetPort !== 8765) {
  throw new Error("loopback proxy target must be marketplace:8765");
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.listen(8765, "127.0.0.1", () => {
  process.stdout.write("trusted loopback proxy ready\n");
});
