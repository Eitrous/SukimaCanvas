import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

import observability from "../../observability/index.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/**
 * An unguessable, non-enumerable Brand Asset id used in the controlled read
 * path. 16 base64url characters (96 bits of entropy) — the internal object key
 * (the file on disk) is never exposed, only this handle.
 *
 * @returns {string}
 */
function randomAssetId() {
  return crypto.randomBytes(12).toString("base64url");
}

/** @typedef {"organizer_logo" | "event_cover"} BrandAssetKind */
/**
 * @typedef {{
 *   assetId: string,
 *   kind: BrandAssetKind,
 *   organizerId: string,
 *   eventId: string | null,
 *   format: "png" | "jpeg" | "webp",
 *   contentType: string,
 *   byteLength: number,
 *   createdAtMs: number,
 * }} StoredBrandAsset
 */

/**
 * Durable storage for validated Brand Asset images.
 *
 * Following the account and organizer stores, the first release keeps metadata
 * as a JSON index under one data directory and the decoded bytes as opaque
 * files beside it — deliberately outside the static web root, so the only way
 * to read an asset is the controlled route, never a static file handler. Bytes
 * are only ever written here after `sniffImage` has accepted them, so an upload
 * can never become an executable or script-bearing page.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 * }} options
 */
function createFileBrandAssetStore(options) {
  const dataDir = options.dataDir;
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || randomAssetId;
  const assetsDir = path.join(dataDir, "brand-assets");
  const INDEX_FILE = path.join(assetsDir, "index.json");

  /** @type {Map<string, StoredBrandAsset>} */
  const assetsById = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    fs.mkdirSync(assetsDir, { recursive: true });
    let contents;
    try {
      contents = fs.readFileSync(INDEX_FILE, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return;
      }
      throw error;
    }
    const parsed = JSON.parse(contents);
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(`Unsupported hosted brand asset store format`);
    }
    for (const asset of /** @type {StoredBrandAsset[]} */ (
      parsed.assets || []
    )) {
      assetsById.set(asset.assetId, asset);
    }
  }

  /**
   * @param {string} assetId
   * @returns {string}
   */
  function bytesPath(assetId) {
    return path.join(assetsDir, `${assetId}.bin`);
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueueWrite(task) {
    const pending = /** @type {Promise<void>} */ (
      writeQueue.then(
        () => {},
        () => {},
      )
    );
    const run = pending.then(task);
    writeQueue = run.then(
      () => {},
      (error) => {
        logger.error("hosted_brand_asset_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistIndexNow() {
    fs.mkdirSync(assetsDir, { recursive: true });
    const temporaryPath = `${INDEX_FILE}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({
        version: STORE_FORMAT_VERSION,
        assets: [...assetsById.values()],
      }),
      "utf8",
    );
    await fs.promises.rename(temporaryPath, INDEX_FILE);
  }

  /**
   * Stores validated image bytes and returns the opaque asset id. The caller is
   * responsible for having decoded the bytes with `sniffImage` and passing the
   * sniffed `format`/`contentType` — never the client-declared MIME type.
   *
   * @param {{
   *   kind: BrandAssetKind,
   *   organizerId: string,
   *   eventId?: string | null,
   *   format: "png" | "jpeg" | "webp",
   *   contentType: string,
   *   bytes: Buffer,
   * }} input
   * @returns {Promise<{assetId: string}>}
   */
  async function putAsset(input) {
    ensureLoaded();
    const assetId = randomId();
    // Write the bytes first (atomic rename) so the index never references a
    // missing file.
    const temporaryPath = `${bytesPath(assetId)}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fs.promises.writeFile(temporaryPath, input.bytes);
    await fs.promises.rename(temporaryPath, bytesPath(assetId));
    /** @type {StoredBrandAsset} */
    const asset = {
      assetId,
      kind: input.kind,
      organizerId: String(input.organizerId || ""),
      eventId: input.eventId ? String(input.eventId) : null,
      format: input.format,
      contentType: input.contentType,
      byteLength: input.bytes.length,
      createdAtMs: clock(),
    };
    assetsById.set(assetId, asset);
    await enqueueWrite(persistIndexNow);
    return { assetId };
  }

  /**
   * @param {string} assetId
   * @returns {StoredBrandAsset | null}
   */
  function getAsset(assetId) {
    ensureLoaded();
    if (typeof assetId !== "string" || assetId === "") return null;
    return assetsById.get(assetId) || null;
  }

  /**
   * Reads an asset's bytes, or null if the id is unknown. Never throws for an
   * unknown id and never exposes the underlying object key.
   *
   * @param {string} assetId
   * @returns {Promise<Buffer | null>}
   */
  async function readAssetBytes(assetId) {
    const asset = getAsset(assetId);
    if (!asset) return null;
    try {
      return await fs.promises.readFile(bytesPath(assetId));
    } catch (error) {
      logger.error("hosted_brand_asset_store.read_failed", {
        error,
        asset_id: assetId,
      });
      return null;
    }
  }

  /**
   * Removes an asset's index entry and its bytes. Idempotent: an unknown id is a
   * no-op. Used when a cover is replaced or cleared so a superseded image does
   * not linger on disk and stay publicly retrievable.
   *
   * @param {string} assetId
   * @returns {Promise<{ok: boolean}>}
   */
  async function deleteAsset(assetId) {
    ensureLoaded();
    const asset = assetsById.get(String(assetId || ""));
    if (!asset) return { ok: false };
    assetsById.delete(asset.assetId);
    await enqueueWrite(async () => {
      await persistIndexNow();
      await fs.promises.rm(bytesPath(asset.assetId), { force: true });
    });
    return { ok: true };
  }

  /**
   * @returns {Promise<void>}
   */
  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return {
    putAsset,
    getAsset,
    readAssetBytes,
    deleteAsset,
    flush,
  };
}

export { createFileBrandAssetStore };
