import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

import observability from "../../observability/index.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;

/** Application field bounds; the route validates first, the store clamps defensively. */
const MAX_ORGANIZER_NAME_LENGTH = 120;
const MAX_CONTACT_NAME_LENGTH = 120;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;

/**
 * @typedef {"pending" | "approved" | "rejected"} ApplicationStatus
 */
/**
 * @typedef {{
 *   applicationId: string,
 *   accountId: string,
 *   organizerName: string,
 *   contactName: string,
 *   contactEmail: string,
 *   description: string,
 *   status: ApplicationStatus,
 *   createdAtMs: number,
 *   decidedAtMs: number | null,
 *   decidedByAccountId: string | null,
 *   operatorNote: string | null,
 *   organizerId: string | null,
 * }} StoredApplication
 */
/**
 * @typedef {{
 *   organizerId: string,
 *   name: string,
 *   createdAtMs: number,
 *   createdFromApplicationId: string,
 * }} StoredOrganizer
 */
/**
 * @typedef {{
 *   organizerId: string,
 *   accountId: string,
 *   role: "owner" | "admin",
 *   grantedAtMs: number,
 * }} StoredRole
 */
/**
 * @typedef {{
 *   recordId: string,
 *   createdAtMs: number,
 *   actorAccountId: string,
 *   actorKind: "account" | "operator",
 *   action: string,
 *   subjectType: string,
 *   subjectId: string,
 *   organizerId: string | null,
 * }} StoredAuditRecord
 */

/**
 * Durable storage for Organizer Applications, Organizers, their role grants,
 * and the Change Audit of administrative actions.
 *
 * The first release keeps this business state in JSON files under one data
 * directory, exactly like the account store: reads come from an in-memory index
 * loaded on first use, and every mutation is appended to a serialized write
 * queue with atomic file replacement. State-machine transitions (submit,
 * approve, reject) run their check-and-mutate synchronously before yielding, so
 * concurrent approvals cannot create a second Organizer or duplicate roles.
 *
 * @param {{
 *   dataDir: string,
 *   clock?: () => number,
 *   randomId?: () => string,
 * }} options
 */
function createFileOrganizerStore(options) {
  const dataDir = options.dataDir;
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());

  /** @type {Map<string, StoredApplication>} */
  const applicationsById = new Map();
  /** @type {Map<string, string[]>} */
  const applicationIdsByAccount = new Map();
  /** @type {Map<string, StoredOrganizer>} */
  const organizersById = new Map();
  /** @type {Map<string, StoredRole>} */
  const rolesByKey = new Map();
  /** @type {StoredAuditRecord[]} */
  const auditRecords = [];
  let loaded = false;
  let writeQueue = Promise.resolve();

  const APPLICATIONS_FILE = path.join(dataDir, "organizer_applications.json");
  const ORGANIZERS_FILE = path.join(dataDir, "organizers.json");
  const ROLES_FILE = path.join(dataDir, "organizer_roles.json");
  const AUDIT_FILE = path.join(dataDir, "change_audit.json");

  /**
   * @param {string} organizerId
   * @param {string} accountId
   * @returns {string}
   */
  function roleKey(organizerId, accountId) {
    return `${organizerId}:${accountId}`;
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    fs.mkdirSync(dataDir, { recursive: true });
    const applications = readStoreFile(APPLICATIONS_FILE, { applications: [] });
    for (const application of /** @type {StoredApplication[]} */ (
      applications.applications || []
    )) {
      applicationsById.set(application.applicationId, application);
      const list = applicationIdsByAccount.get(application.accountId) || [];
      list.push(application.applicationId);
      applicationIdsByAccount.set(application.accountId, list);
    }
    // Preserve submission order for each account so "current" is deterministic.
    for (const list of applicationIdsByAccount.values()) {
      list.sort((left, right) => {
        const leftApp = applicationsById.get(left);
        const rightApp = applicationsById.get(right);
        return (leftApp?.createdAtMs || 0) - (rightApp?.createdAtMs || 0);
      });
    }
    const organizers = readStoreFile(ORGANIZERS_FILE, { organizers: [] });
    for (const organizer of /** @type {StoredOrganizer[]} */ (
      organizers.organizers || []
    )) {
      organizersById.set(organizer.organizerId, organizer);
    }
    const roles = readStoreFile(ROLES_FILE, { roles: [] });
    for (const role of /** @type {StoredRole[]} */ (roles.roles || [])) {
      rolesByKey.set(roleKey(role.organizerId, role.accountId), role);
    }
    const audit = readStoreFile(AUDIT_FILE, { records: [] });
    for (const record of /** @type {StoredAuditRecord[]} */ (
      audit.records || []
    )) {
      auditRecords.push(record);
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
      throw new Error(
        `Unsupported hosted organizer store format in ${filePath}`,
      );
    }
    return parsed;
  }

  /**
   * Appends one persistence task to the serialized write queue. The caller
   * observes failures of its own task; the chain itself stays alive so a single
   * failed write cannot poison later ones.
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
        logger.error("hosted_organizer_store.write_failed", { error });
      },
    );
    return run;
  }

  /**
   * @returns {Promise<void>}
   */
  async function persistNow() {
    fs.mkdirSync(dataDir, { recursive: true });
    await writeStoreFile(APPLICATIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      applications: [...applicationsById.values()],
    });
    await writeStoreFile(ORGANIZERS_FILE, {
      version: STORE_FORMAT_VERSION,
      organizers: [...organizersById.values()],
    });
    await writeStoreFile(ROLES_FILE, {
      version: STORE_FORMAT_VERSION,
      roles: [...rolesByKey.values()],
    });
    await writeStoreFile(AUDIT_FILE, {
      version: STORE_FORMAT_VERSION,
      records: auditRecords,
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
   * @param {string} value
   * @param {number} maxLength
   * @returns {string}
   */
  function clampString(value, maxLength) {
    return String(value == null ? "" : value)
      .trim()
      .slice(0, maxLength);
  }

  /**
   * Appends one Change Audit record for an administrative action. In-memory
   * only until the enclosing mutation persists.
   *
   * @param {{
   *   actorAccountId: string,
   *   actorKind: "account" | "operator",
   *   action: string,
   *   subjectType: string,
   *   subjectId: string,
   *   organizerId?: string | null,
   * }} input
   * @returns {void}
   */
  function recordAudit(input) {
    auditRecords.push({
      recordId: randomId(),
      createdAtMs: clock(),
      actorAccountId: input.actorAccountId,
      actorKind: input.actorKind,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      organizerId: input.organizerId ?? null,
    });
  }

  /**
   * Returns the account's most recent application, or null.
   *
   * @param {string} accountId
   * @returns {StoredApplication | null}
   */
  function currentApplicationFor(accountId) {
    const list = applicationIdsByAccount.get(accountId);
    if (!list || list.length === 0) return null;
    const newestId = list[list.length - 1];
    return (newestId && applicationsById.get(newestId)) || null;
  }

  /**
   * Submits a new Organizer Application for a verified account. Only an account
   * whose most recent application was rejected (or who has none) may apply, so a
   * repeat submission while one is under review — or after one was already
   * approved — is refused deterministically without creating a conflicting
   * application or a duplicate Organizer.
   *
   * @param {{
   *   accountId: string,
   *   organizerName: string,
   *   contactName: string,
   *   contactEmail: string,
   *   description?: string,
   * }} input
   * @returns {Promise<{ok: true, application: StoredApplication} | {ok: false, reason: "already_pending" | "already_approved"}>}
   */
  async function submitApplication(input) {
    ensureLoaded();
    const accountId = String(input.accountId || "");
    if (accountId === "")
      throw new Error("submitApplication requires accountId");
    const existing = currentApplicationFor(accountId);
    if (existing && existing.status === "pending") {
      return { ok: false, reason: "already_pending" };
    }
    if (existing && existing.status === "approved") {
      return { ok: false, reason: "already_approved" };
    }
    /** @type {StoredApplication} */
    const application = {
      applicationId: randomId(),
      accountId,
      organizerName: clampString(
        input.organizerName,
        MAX_ORGANIZER_NAME_LENGTH,
      ),
      contactName: clampString(input.contactName, MAX_CONTACT_NAME_LENGTH),
      contactEmail: clampString(input.contactEmail, MAX_CONTACT_EMAIL_LENGTH),
      description: clampString(input.description || "", MAX_DESCRIPTION_LENGTH),
      status: "pending",
      createdAtMs: clock(),
      decidedAtMs: null,
      decidedByAccountId: null,
      operatorNote: null,
      organizerId: null,
    };
    applicationsById.set(application.applicationId, application);
    const list = applicationIdsByAccount.get(accountId) || [];
    list.push(application.applicationId);
    applicationIdsByAccount.set(accountId, list);
    recordAudit({
      actorAccountId: accountId,
      actorKind: "account",
      action: "organizer_application.submitted",
      subjectType: "organizer_application",
      subjectId: application.applicationId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, application };
  }

  /**
   * The applicant-facing projection of their current application: it never
   * exposes the operator-only note or the deciding operator's identity.
   *
   * @param {string} accountId
   * @returns {{
   *   applicationId: string,
   *   status: ApplicationStatus,
   *   organizerName: string,
   *   contactName: string,
   *   contactEmail: string,
   *   description: string,
   *   createdAtMs: number,
   *   decidedAtMs: number | null,
   *   organizerId: string | null,
   * } | null}
   */
  function getApplicantView(accountId) {
    ensureLoaded();
    const application = currentApplicationFor(String(accountId || ""));
    if (!application) return null;
    return {
      applicationId: application.applicationId,
      status: application.status,
      organizerName: application.organizerName,
      contactName: application.contactName,
      contactEmail: application.contactEmail,
      description: application.description,
      createdAtMs: application.createdAtMs,
      decidedAtMs: application.decidedAtMs,
      organizerId: application.organizerId,
    };
  }

  /**
   * The pending review queue, oldest submission first.
   *
   * @returns {StoredApplication[]}
   */
  function listPendingApplications() {
    ensureLoaded();
    return [...applicationsById.values()]
      .filter((application) => application.status === "pending")
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * @param {string} applicationId
   * @returns {StoredApplication | null}
   */
  function getApplicationById(applicationId) {
    ensureLoaded();
    if (typeof applicationId !== "string" || applicationId === "") return null;
    return applicationsById.get(applicationId) || null;
  }

  /**
   * Approves a pending application: atomically creates the Organizer, grants
   * the applicant Organizer Owner, and marks the application approved. The
   * check-and-mutate is synchronous, so a concurrent second approval sees a
   * non-pending status and creates nothing.
   *
   * @param {{applicationId: string, operatorAccountId: string}} input
   * @returns {Promise<{ok: true, organizerId: string} | {ok: false, reason: "not_found" | "not_pending"}>}
   */
  async function approveApplication(input) {
    ensureLoaded();
    const application = applicationsById.get(String(input.applicationId || ""));
    if (!application) return { ok: false, reason: "not_found" };
    if (application.status !== "pending") {
      return { ok: false, reason: "not_pending" };
    }
    const operatorAccountId = String(input.operatorAccountId || "");
    const now = clock();
    const organizerId = randomId();
    organizersById.set(organizerId, {
      organizerId,
      name: application.organizerName,
      createdAtMs: now,
      createdFromApplicationId: application.applicationId,
    });
    rolesByKey.set(roleKey(organizerId, application.accountId), {
      organizerId,
      accountId: application.accountId,
      role: "owner",
      grantedAtMs: now,
    });
    application.status = "approved";
    application.decidedAtMs = now;
    application.decidedByAccountId = operatorAccountId;
    application.organizerId = organizerId;
    recordAudit({
      actorAccountId: operatorAccountId,
      actorKind: "operator",
      action: "organizer_application.approved",
      subjectType: "organizer_application",
      subjectId: application.applicationId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, organizerId };
  }

  /**
   * Rejects a pending application, recording an operator-only note that is
   * never shown to the applicant.
   *
   * @param {{applicationId: string, operatorAccountId: string, note?: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_pending"}>}
   */
  async function rejectApplication(input) {
    ensureLoaded();
    const application = applicationsById.get(String(input.applicationId || ""));
    if (!application) return { ok: false, reason: "not_found" };
    if (application.status !== "pending") {
      return { ok: false, reason: "not_pending" };
    }
    const operatorAccountId = String(input.operatorAccountId || "");
    application.status = "rejected";
    application.decidedAtMs = clock();
    application.decidedByAccountId = operatorAccountId;
    application.operatorNote = clampString(
      input.note || "",
      MAX_OPERATOR_NOTE_LENGTH,
    );
    recordAudit({
      actorAccountId: operatorAccountId,
      actorKind: "operator",
      action: "organizer_application.rejected",
      subjectType: "organizer_application",
      subjectId: application.applicationId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Change Audit records for one application, oldest first.
   *
   * @param {string} applicationId
   * @returns {StoredAuditRecord[]}
   */
  function listAuditForApplication(applicationId) {
    ensureLoaded();
    return auditRecords
      .filter(
        (record) =>
          record.subjectType === "organizer_application" &&
          record.subjectId === applicationId,
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * @param {string} organizerId
   * @returns {StoredOrganizer | null}
   */
  function getOrganizerById(organizerId) {
    ensureLoaded();
    if (typeof organizerId !== "string" || organizerId === "") return null;
    return organizersById.get(organizerId) || null;
  }

  /**
   * @param {string} organizerId
   * @returns {StoredRole[]}
   */
  function listRolesForOrganizer(organizerId) {
    ensureLoaded();
    return [...rolesByKey.values()].filter(
      (role) => role.organizerId === organizerId,
    );
  }

  /**
   * @param {string} accountId
   * @returns {StoredRole[]}
   */
  function listRolesForAccount(accountId) {
    ensureLoaded();
    return [...rolesByKey.values()].filter(
      (role) => role.accountId === accountId,
    );
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
    submitApplication,
    getApplicantView,
    listPendingApplications,
    getApplicationById,
    approveApplication,
    rejectApplication,
    listAuditForApplication,
    getOrganizerById,
    listRolesForOrganizer,
    listRolesForAccount,
    flush,
  };
}

export { createFileOrganizerStore };
