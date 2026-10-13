import neo4j, { Driver, Session } from "neo4j-driver";
import { config } from "./config.js";
import { log } from "./log.js";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
      { disableLosslessIntegers: true }
    );
  }
  return driver;
}

/** Run a read query in a fresh session and always close it. */
export async function read<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const session: Session = getDriver().session({
    database: config.neo4j.database,
    defaultAccessMode: neo4j.session.READ,
  });
  try {
    const res = await session.run(cypher, params);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

/** Run a write query (ETL only — never on the demo hot path). */
export async function write(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const session = getDriver().session({
    database: config.neo4j.database,
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

export async function healthcheck(): Promise<boolean> {
  try {
    await read("RETURN 1 AS ok");
    return true;
  } catch (err) {
    // Surface the cause (auth vs. unreachable vs. wrong DB) so a "not ready"
    // /api/health has an explanation in the logs instead of a silent boolean.
    log.warn("[neo4j] healthcheck failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
