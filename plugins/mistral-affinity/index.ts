/**
 * Sticky Mistral affinity header.
 *
 * V2 port: the V1 `chat.headers` hook is now `session.hook("model.request")`,
 * which exposes the outgoing header map for the selected model.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin";

// plugins/mistral-affinity/index.ts -> the config root.
const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = join(CONFIG_DIR, "data");
const SESSION_DIR = join(DATA_DIR, "mistral-affinity");
const LEGACY_STATE_FILE = join(DATA_DIR, "mistral-affinity.json");
const HEADER_NAME = "x-affinity";
const MISTRAL_PROVIDER_IDS = new Set(["mistral", "myMistral"]);
const READ_RETRY_ATTEMPTS = 5;
const READ_RETRY_DELAY_MS = 10;

const affinityCache = new Map<string, string>();
const affinityInFlight = new Map<string, Promise<string>>();
let legacyStatePromise: Promise<Record<string, string>> | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLegacyState(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function loadLegacyState(): Promise<Record<string, string>> {
  try {
    return parseLegacyState(JSON.parse(await readFile(LEGACY_STATE_FILE, "utf8")));
  } catch {
    return {};
  }
}

function getLegacyState(): Promise<Record<string, string>> {
  legacyStatePromise ??= loadLegacyState();
  return legacyStatePromise;
}

function sessionFileFor(sessionID: string): string {
  const filename = createHash("sha256").update(sessionID).digest("hex");
  return join(SESSION_DIR, `${filename}.json`);
}

function parseSessionAffinity(value: unknown, sessionID: string): string | undefined {
  if (!isObject(value)) return undefined;
  if (value.sessionID !== sessionID) return undefined;
  if (typeof value.affinity !== "string" || value.affinity.length === 0) return undefined;
  return value.affinity;
}

async function readSessionFile(
  sessionID: string,
): Promise<{ affinity?: string; exists: boolean }> {
  try {
    const affinity = parseSessionAffinity(
      JSON.parse(await readFile(sessionFileFor(sessionID), "utf8")),
      sessionID,
    );
    return affinity ? { affinity, exists: true } : { exists: true };
  } catch (error) {
    return { exists: !isNodeError(error, "ENOENT") };
  }
}

async function readSessionPathAffinity(
  path: string,
  sessionID: string,
): Promise<string | undefined> {
  try {
    return parseSessionAffinity(JSON.parse(await readFile(path, "utf8")), sessionID);
  } catch {
    return undefined;
  }
}

async function readSessionAffinity(sessionID: string): Promise<string | undefined> {
  const sessionFile = await readSessionFile(sessionID);
  if (sessionFile.affinity) affinityCache.set(sessionID, sessionFile.affinity);
  return sessionFile.affinity;
}

async function readSessionAffinityWithRetry(sessionID: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    const affinity = await readSessionAffinity(sessionID);
    if (affinity) return affinity;
    if (attempt < READ_RETRY_ATTEMPTS - 1) await delay(READ_RETRY_DELAY_MS);
  }

  return undefined;
}

async function legacyAffinityFor(sessionID: string): Promise<string | undefined> {
  return (await getLegacyState())[sessionID];
}

async function writeSessionAffinity(sessionID: string, affinity: string): Promise<string> {
  await mkdir(SESSION_DIR, { recursive: true });
  const sessionFile = sessionFileFor(sessionID);
  const tempFile = `${sessionFile}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  let tempCreated = false;
  let publishError: unknown;

  try {
    await writeFile(tempFile, `${JSON.stringify({ sessionID, affinity }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    tempCreated = true;
    await link(tempFile, sessionFile);
  } catch (error) {
    publishError = error;
    throw error;
  } finally {
    if (tempCreated) {
      try {
        await unlink(tempFile);
      } catch (error) {
        if (!publishError && !isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  return affinity;
}

async function repairSessionAffinity(sessionID: string, affinity: string): Promise<string> {
  const sessionFile = sessionFileFor(sessionID);
  const corruptFile = `${sessionFile}.corrupt.${process.pid}.${Date.now()}.${randomUUID()}`;
  let movedAffinity: string | undefined;

  try {
    await rename(sessionFile, corruptFile);
    movedAffinity = await readSessionPathAffinity(corruptFile, sessionID);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      return (await readSessionAffinityWithRetry(sessionID)) ?? affinity;
    }
  }

  try {
    return await writeSessionAffinity(sessionID, movedAffinity ?? affinity);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      return (await readSessionAffinityWithRetry(sessionID)) ?? movedAffinity ?? affinity;
    }

    return movedAffinity ?? affinity;
  }
}

async function createSessionAffinity(sessionID: string, affinity: string): Promise<string> {
  try {
    return await writeSessionAffinity(sessionID, affinity);
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) return affinity;

    return (
      (await readSessionAffinityWithRetry(sessionID)) ??
      (await repairSessionAffinity(sessionID, affinity))
    );
  }
}

async function resolveAffinityForSession(sessionID: string): Promise<string> {
  const sessionFile = await readSessionFile(sessionID);
  if (sessionFile.affinity) {
    affinityCache.set(sessionID, sessionFile.affinity);
    return sessionFile.affinity;
  }

  if (sessionFile.exists) {
    const affinity =
      affinityCache.get(sessionID) ?? (await legacyAffinityFor(sessionID)) ?? randomUUID();
    const savedAffinity = await createSessionAffinity(sessionID, affinity);

    affinityCache.set(sessionID, savedAffinity);
    return savedAffinity;
  }

  const affinity =
    (await legacyAffinityFor(sessionID)) ?? affinityCache.get(sessionID) ?? randomUUID();
  const savedAffinity = await createSessionAffinity(sessionID, affinity);

  affinityCache.set(sessionID, savedAffinity);
  return savedAffinity;
}

async function affinityForSession(sessionID: string): Promise<string> {
  const inFlight = affinityInFlight.get(sessionID);
  if (inFlight) return inFlight;

  const affinityPromise = resolveAffinityForSession(sessionID).finally(() => {
    affinityInFlight.delete(sessionID);
  });
  affinityInFlight.set(sessionID, affinityPromise);
  return affinityPromise;
}

export default Plugin.define({
  id: "mistral-affinity",
  async setup(ctx) {
    // V2 has no app log API; the server log keeps plugin console output.
    async function logFailure(error: unknown): Promise<void> {
      console.error(
        "mistral-affinity: failed to set the Mistral affinity header:",
        error instanceof Error ? error.message : String(error),
      );
    }

    await ctx.session.hook("model.request", async (event) => {
      if (!MISTRAL_PROVIDER_IDS.has(event.model.providerID)) return;

      try {
        event.headers[HEADER_NAME] = await affinityForSession(event.sessionID);
      } catch (error) {
        await logFailure(error);
      }
    });
  },
});
