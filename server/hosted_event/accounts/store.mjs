import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";
import observability from "../../observability/index.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;
const MAX_SESSIONS_PER_ACCOUNT = 50;
const SESSION_TOUCH_INTERVAL_MS = 60_000;

/**
 * @typedef {{
 *   accountId: string,
 *   email: string,
 *   passwordHash: string,
 *   status: "active" | "disabled",
 *   verifiedAtMs: number | null,
 *   createdAtMs: number,
 * }} StoredAccount
 */
/**
 * @typedef {{
 *   accountId: string,
 *   expiresAtMs: number,
 * }} StoredVerificationToken
 */
/**
 * @typedef {{
 *   accountId: string,
 *   createdAtMs: number,
 *   lastSeenAtMs: number,
 *   expiresAtMs: number,
 * }} StoredSession
 */

/**
 * Durable account storage for the Hosted Event Service.
 *
 * The first release keeps business state in JSON files under one data
 * directory; this store is the only seam that touches them. Reads are served
 * from an in-memory index loaded synchronously on first use, and every
 * mutation is appended to a serialized write queue with atomic file
 * replacement. Verification tokens and session ids are persisted only as
 * SHA-256 digests; raw values exist solely in the verification email and the
 * browser cookie.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   sessionMaxAgeMs?: number,
 *   sessionIdleMs?: number,
 *   verificationTokenTtlMs?: number,
 *   randomToken?: () => string,
 * }} options
 */
function createFileAccountStore(options) {
  const dataDir = options.dataDir;
  const clock = options.clock || (() => Date.now());
  const sessionMaxAgeMs = positiveOr(
    options.sessionMaxAgeMs,
    30 * 24 * 60 * 60 * 1000,
  );
  const sessionIdleMs = positiveOr(options.sessionIdleMs, 12 * 60 * 60 * 1000);
  const verificationTokenTtlMs = positiveOr(
    options.verificationTokenTtlMs,
    24 * 60 * 60 * 1000,
  );
  const randomToken =
    options.randomToken || (() => crypto.randomBytes(32).toString("base64url"));

  /** @type {Map<string, StoredAccount>} */
  const accountsById = new Map();
  /** @type {Map<string, string>} */
  const accountIdsByEmail = new Map();
  /** @type {Map<string, StoredVerificationToken>} */
  const verificationTokensByDigest = new Map();
  /** @type {Map<string, StoredSession>} */
  const sessionsByDigest = new Map();
  /** @type {Map<string, string>} */
  const tokenDigestsByAccountId = new Map();
  let loaded = false;
  let writeQueue = Promise.resolve();

  const ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
  const VERIFICATIONS_FILE = path.join(dataDir, "verifications.json");
  const SESSIONS_FILE = path.join(dataDir, "sessions.json");

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    fs.mkdirSync(dataDir, { recursive: true });
    const accounts = readStoreFile(ACCOUNTS_FILE, { accounts: [] });
    for (const account of /** @type {StoredAccount[]} */ (
      accounts.accounts || []
    )) {
      accountsById.set(account.accountId, account);
      accountIdsByEmail.set(account.email, account.accountId);
    }
    const verifications = readStoreFile(VERIFICATIONS_FILE, { tokens: {} });
    for (const [
      digestValue,
      token,
    ] of /** @type {[string, StoredVerificationToken][]} */ (
      Object.entries(verifications.tokens || {})
    )) {
      verificationTokensByDigest.set(digestValue, token);
      tokenDigestsByAccountId.set(token.accountId, digestValue);
    }
    const sessions = readStoreFile(SESSIONS_FILE, { sessions: {} });
    for (const [
      digestValue,
      session,
    ] of /** @type {[string, StoredSession][]} */ (
      Object.entries(sessions.sessions || {})
    )) {
      sessionsByDigest.set(digestValue, session);
    }
  }

  /**
   * @template T
   * @param {string} filePath
   * @param {T} fallback
   * @returns {T}
   */
  function readStoreFile(filePath, fallback) {
    let contents;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
    const parsed = JSON.parse(contents);
    if (parsed.version !== STORE_FORMAT_VERSION) {
      throw new Error(`Unsupported hosted account store format in ${filePath}`);
    }
    return parsed;
  }

  /**
   * Appends one persistence task to the serialized write queue. The caller
   * observes failures of its own task; the chain itself stays alive so a
   * single failed write cannot poison later ones.
   *
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
        logger.error("hosted_account_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    const now = clock();
    for (const [tokenDigest, token] of verificationTokensByDigest) {
      if (token.expiresAtMs <= now) {
        verificationTokensByDigest.delete(tokenDigest);
        if (tokenDigestsByAccountId.get(token.accountId) === tokenDigest) {
          tokenDigestsByAccountId.delete(token.accountId);
        }
      }
    }
    for (const [sessionDigest, session] of sessionsByDigest) {
      if (session.expiresAtMs <= now) sessionsByDigest.delete(sessionDigest);
    }
    fs.mkdirSync(dataDir, { recursive: true });
    await writeStoreFile(ACCOUNTS_FILE, {
      version: STORE_FORMAT_VERSION,
      accounts: [...accountsById.values()],
    });
    await writeStoreFile(VERIFICATIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      tokens: Object.fromEntries(verificationTokensByDigest),
    });
    await writeStoreFile(SESSIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      sessions: Object.fromEntries(sessionsByDigest),
    });
  }

  /**
   * @param {string} filePath
   * @param {unknown} payload
   * @returns {Promise<void>}
   */
  async function writeStoreFile(filePath, payload) {
    const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify(payload), "utf8");
    await fs.promises.rename(temporaryPath, filePath);
  }

  /**
   * @param {string} rawToken
   * @returns {string}
   */
  function digest(rawToken) {
    return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
  }

  /**
   * @param {{email: string, passwordHash: string}} input
   * @returns {Promise<StoredAccount>}
   */
  async function createAccount(input) {
    ensureLoaded();
    const email = normalizeEmail(input.email);
    if (!isValidNormalizedEmail(email)) {
      throw new Error("invalid account email");
    }
    if (accountIdsByEmail.has(email)) {
      throw new Error(`email already registered: ${email}`);
    }
    /** @type {StoredAccount} */
    const account = {
      accountId: crypto.randomUUID(),
      email,
      passwordHash: String(input.passwordHash || ""),
      status: "active",
      verifiedAtMs: null,
      createdAtMs: clock(),
    };
    accountsById.set(account.accountId, account);
    accountIdsByEmail.set(email, account.accountId);
    await enqueueWrite(persistNow);
    return account;
  }

  /**
   * @param {string} email
   * @returns {StoredAccount | null}
   */
  function getAccountByEmail(email) {
    ensureLoaded();
    const accountId = accountIdsByEmail.get(normalizeEmail(email));
    return accountId ? accountsById.get(accountId) || null : null;
  }

  /**
   * @param {string} accountId
   * @returns {StoredAccount | null}
   */
  function getAccountById(accountId) {
    ensureLoaded();
    return accountsById.get(accountId) || null;
  }

  /**
   * @param {string} accountId
   * @param {number} verifiedAtMs
   * @returns {Promise<void>}
   */
  async function markAccountVerified(accountId, verifiedAtMs) {
    ensureLoaded();
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    account.verifiedAtMs = verifiedAtMs;
    await enqueueWrite(persistNow);
  }

  /**
   * @param {string} accountId
   * @param {"active" | "disabled"} status
   * @returns {Promise<void>}
   */
  async function setAccountStatus(accountId, status) {
    ensureLoaded();
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    account.status = status;
    if (status === "disabled") await revokeAccountSessions(accountId);
    await enqueueWrite(persistNow);
  }

  /**
   * Issues a new single-use verification token for the account, replacing any
   * outstanding token so only the newest email link works.
   *
   * @param {string} accountId
   * @returns {Promise<string>}
   */
  async function createVerificationToken(accountId) {
    ensureLoaded();
    if (!accountsById.has(accountId)) {
      throw new Error(`unknown account: ${accountId}`);
    }
    const previousDigest = tokenDigestsByAccountId.get(accountId);
    if (previousDigest !== undefined) {
      verificationTokensByDigest.delete(previousDigest);
      tokenDigestsByAccountId.delete(accountId);
    }
    const rawToken = randomToken();
    const tokenDigest = digest(rawToken);
    verificationTokensByDigest.set(tokenDigest, {
      accountId,
      expiresAtMs: clock() + verificationTokenTtlMs,
    });
    tokenDigestsByAccountId.set(accountId, tokenDigest);
    await enqueueWrite(persistNow);
    return rawToken;
  }

  /**
   * @param {string} rawToken
   * @returns {Promise<string | null>}
   */
  async function consumeVerificationToken(rawToken) {
    ensureLoaded();
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    const tokenDigest = digest(rawToken);
    const token = verificationTokensByDigest.get(tokenDigest);
    if (!token) return null;
    verificationTokensByDigest.delete(tokenDigest);
    if (tokenDigestsByAccountId.get(token.accountId) === tokenDigest) {
      tokenDigestsByAccountId.delete(token.accountId);
    }
    await enqueueWrite(persistNow);
    if (token.expiresAtMs <= clock()) return null;
    return token.accountId;
  }

  /**
   * @param {string} accountId
   * @returns {Promise<string>}
   */
  async function createSession(accountId) {
    ensureLoaded();
    if (!accountsById.has(accountId)) {
      throw new Error(`unknown account: ${accountId}`);
    }
    const now = clock();
    const existing = [...sessionsByDigest.entries()]
      .filter(([, session]) => session.accountId === accountId)
      .sort(([, left], [, right]) => left.lastSeenAtMs - right.lastSeenAtMs);
    while (existing.length >= MAX_SESSIONS_PER_ACCOUNT) {
      const oldest = existing.shift();
      if (oldest) sessionsByDigest.delete(oldest[0]);
    }
    const rawSessionId = randomToken();
    sessionsByDigest.set(digest(rawSessionId), {
      accountId,
      createdAtMs: now,
      lastSeenAtMs: now,
      expiresAtMs: now + sessionMaxAgeMs,
    });
    await enqueueWrite(persistNow);
    return rawSessionId;
  }

  /**
   * Shared session validation: absolute-expiry, idle-expiry, and last-seen
   * refresh. Returns null and drops the session when it is no longer valid.
   *
   * @param {string} sessionDigest
   * @param {StoredSession} session
   * @returns {{accountId: string} | null}
   */
  function validateSession(sessionDigest, session) {
    const now = clock();
    if (
      session.expiresAtMs <= now ||
      now - session.lastSeenAtMs > sessionIdleMs
    ) {
      sessionsByDigest.delete(sessionDigest);
      enqueueWrite(persistNow);
      return null;
    }
    if (now - session.lastSeenAtMs > SESSION_TOUCH_INTERVAL_MS) {
      session.lastSeenAtMs = now;
      enqueueWrite(persistNow);
    }
    return { accountId: session.accountId };
  }

  /**
   * @param {string} rawSessionId
   * @returns {Promise<{accountId: string} | null>}
   */
  async function resolveSession(rawSessionId) {
    ensureLoaded();
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
      return null;
    }
    const sessionDigest = digest(rawSessionId);
    const session = sessionsByDigest.get(sessionDigest);
    if (!session) return null;
    return validateSession(sessionDigest, session);
  }

  /**
   * Synchronous session lookup for page rendering. Reads memory only and
   * lets the write queue observe the scheduled persist without blocking the
   * render on disk.
   *
   * @param {string} rawSessionId
   * @returns {{accountId: string} | null}
   */
  function peekSession(rawSessionId) {
    ensureLoaded();
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
      return null;
    }
    const sessionDigest = digest(rawSessionId);
    const session = sessionsByDigest.get(sessionDigest);
    if (!session) return null;
    return validateSession(sessionDigest, session);
  }

  /**
   * Revokes every session held by an account, e.g. when the account is
   * disabled.
   *
   * @param {string} accountId
   * @returns {Promise<void>}
   */
  async function revokeAccountSessions(accountId) {
    ensureLoaded();
    let revoked = false;
    for (const [sessionDigest, session] of sessionsByDigest) {
      if (session.accountId === accountId) {
        sessionsByDigest.delete(sessionDigest);
        revoked = true;
      }
    }
    if (revoked) await enqueueWrite(persistNow);
  }

  /**
   * @param {string} rawSessionId
   * @returns {Promise<void>}
   */
  async function revokeSession(rawSessionId) {
    ensureLoaded();
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) return;
    const sessionDigest = digest(rawSessionId);
    if (!sessionsByDigest.has(sessionDigest)) return;
    sessionsByDigest.delete(sessionDigest);
    await enqueueWrite(persistNow);
  }

  /**
   * Replaces the password hash of an existing account. Only used while an
   * account is still unverified and its registration is repeated.
   *
   * @param {string} accountId
   * @param {string} passwordHash
   * @returns {Promise<void>}
   */
  async function updateAccountPassword(accountId, passwordHash) {
    ensureLoaded();
    const account = accountsById.get(accountId);
    if (!account) throw new Error(`unknown account: ${accountId}`);
    account.passwordHash = String(passwordHash || "");
    await enqueueWrite(persistNow);
  }

  /**
   * Resolves once every scheduled write has landed on disk.
   *
   * @returns {Promise<void>}
   */
  async function flush() {
    ensureLoaded();
    await writeQueue;
  }

  return {
    createAccount,
    getAccountByEmail,
    getAccountById,
    markAccountVerified,
    setAccountStatus,
    updateAccountPassword,
    createVerificationToken,
    consumeVerificationToken,
    createSession,
    resolveSession,
    peekSession,
    revokeSession,
    flush,
  };
}

/**
 * @param {number | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export { createFileAccountStore };
