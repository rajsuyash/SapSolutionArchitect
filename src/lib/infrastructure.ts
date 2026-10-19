import { CreateBucketCommand, HeadBucketCommand, S3Client, type BucketLocationConstraint } from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import type { Environment } from "./env";

type Service = "database" | "queue";

/** One instance per server/worker process. No network connections are opened on import. */
export function createInfrastructure(
  config: Environment,
  reportError: (service: Service) => void = (service) => console.error(`Infrastructure error: ${service}`),
) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    application_name: "sap-pm",
  });
  // Idle pool and queue errors are EventEmitter events; never log raw errors or credentials.
  pool.on("error", () => reportError("database"));
  const db = drizzle(pool);
  const queue = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: "pgboss",
    max: 5,
    connectionTimeoutMillis: 3000,
  });
  queue.on("error", () => reportError("queue"));
  const storage = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
  });

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      // Jobs may still use the DB/storage while draining, so close the queue first.
      try {
        await queue.stop({ graceful: true, timeout: 10000 });
      } finally {
        storage.destroy();
        await pool.end();
      }
    })();
    return closing;
  }

  return { pool, db, queue, storage, close };
}

/** Local bootstrap only. Production buckets must be provisioned by deployment infrastructure. */
export async function ensureDevelopmentBucket(storage: S3Client, config: Environment): Promise<void> {
  if (config.NODE_ENV === "production") throw new Error("Cannot provision a bucket in production");
  try {
    await storage.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "NotFound") throw error;
  }
  try {
    await storage.send(new CreateBucketCommand({
      Bucket: config.S3_BUCKET,
      ...(config.S3_REGION === "us-east-1" ? {} : {
        CreateBucketConfiguration: { LocationConstraint: config.S3_REGION as BucketLocationConstraint },
      }),
    }));
  } catch (error) {
    // A second local process may have created the same bucket after our HEAD request.
    if (!(error instanceof Error) || error.name !== "BucketAlreadyOwnedByYou") throw error;
  }
}
