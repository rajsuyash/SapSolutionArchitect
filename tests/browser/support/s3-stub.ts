import { once } from "node:events";
import { createServer, type Server } from "node:http";

/**
 * Minimal path-style S3 stub for the browser harness when MinIO/Docker is unavailable.
 * It implements ONLY what the exercised paths use (src/lib/infrastructure.ts):
 * HeadBucket and CreateBucket on the configured bucket. Everything else returns 501,
 * so a new storage call fails loudly instead of being silently masked.
 */
export async function startS3Stub(bucket: string): Promise<{ endpoint: string; server: Server }> {
  let created = false; // ponytail: a single configured bucket; CreateBucket flips it, like a fresh MinIO.
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    const isBucket = path === `/${bucket}` || path === `/${bucket}/`;
    if (isBucket && req.method === "HEAD") { res.writeHead(created ? 200 : 404).end(); return; }
    if (isBucket && req.method === "PUT") { created = true; res.writeHead(200).end(); return; }
    res.writeHead(501, { "content-type": "application/xml" })
      .end(`<Error><Code>NotImplemented</Code><Message>S3 stub does not implement ${req.method} ${path}</Message></Error>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No S3 stub port");
  return { endpoint: `http://127.0.0.1:${address.port}`, server };
}
