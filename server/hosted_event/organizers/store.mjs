import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

import observability from "../../observability/index.mjs";

const { logger } = observability;

const STORE_FORMAT_VERSION = 1;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An unguessable, non-enumerable Event Public ID for public service URLs. 16
 * base64url characters (96 bits of entropy) — internal reservation and board
 * session identifiers never appear in public URLs.
 *
 * @returns {string}
 */
function randomPublicEventId() {
  return crypto.randomBytes(12).toString("base64url");
}

/** Application field bounds; the route validates first, the store clamps defensively. */
const MAX_ORGANIZER_NAME_LENGTH = 120;
const MAX_CONTACT_NAME_LENGTH = 120;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;

/** @typedef {"owner" | "admin"} MemberRole */

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
 *   role: MemberRole,
 *   grantedAtMs: number,
 * }} StoredRole
 */
/**
 * @typedef {"pending" | "accepted" | "revoked" | "declined"} InvitationStatus
 */
/**
 * @typedef {{
 *   invitationId: string,
 *   organizerId: string,
 *   email: string,
 *   role: MemberRole,
 *   status: InvitationStatus,
 *   invitedByAccountId: string,
 *   createdAtMs: number,
 *   expiresAtMs: number,
 *   acceptedByAccountId: string | null,
 *   acceptedAtMs: number | null,
 * }} StoredInvitation
 */
/**
 * @typedef {"draft" | "submitted" | "approved" | "rejected" | "cancelled"} ReservationStatus
 */
/**
 * @typedef {{
 *   reservationId: string,
 *   organizerId: string,
 *   eventName: string,
 *   description: string,
 *   visibility: "public" | "unlisted",
 *   startsAtMs: number,
 *   endsAtMs: number,
 *   requestedSeats: number,
 *   status: ReservationStatus,
 *   createdByAccountId: string,
 *   createdAtMs: number,
 *   submittedAtMs: number | null,
 *   decidedAtMs: number | null,
 *   decidedByAccountId: string | null,
 *   operatorNote: string | null,
 *   eventId: string | null,
 * }} StoredReservation
 */
/**
 * @typedef {{
 *   eventId: string,
 *   publicId: string,
 *   reservationId: string,
 *   organizerId: string,
 *   name: string,
 *   visibility: "public" | "unlisted",
 *   startsAtMs: number,
 *   endsAtMs: number,
 *   createdAtMs: number,
 * }} StoredEvent
 */
/**
 * @typedef {{
 *   boardSessionId: string,
 *   eventId: string,
 *   reservationId: string,
 *   organizerId: string,
 *   status: "scheduled",
 *   seats: number,
 *   windowStartMs: number,
 *   windowEndMs: number,
 *   createdAtMs: number,
 * }} StoredBoardSession
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
 * Computes the peak concurrent Board Session count and Participant Seat total
 * within a candidate capacity window, including the candidate itself. The
 * active count only rises at an allocation's start, so evaluating every start
 * point inside the window (plus the window's own start) finds both peaks.
 *
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @param {number} seats
 * @param {{windowStartMs: number, windowEndMs: number, seats: number}[]} allocations
 * @returns {{maxSessions: number, maxSeats: number}}
 */
function computeCapacityPeak(windowStartMs, windowEndMs, seats, allocations) {
  const overlapping = allocations.filter(
    (a) => a.windowStartMs < windowEndMs && windowStartMs < a.windowEndMs,
  );
  const points = [windowStartMs];
  for (const a of overlapping) {
    if (a.windowStartMs >= windowStartMs && a.windowStartMs < windowEndMs) {
      points.push(a.windowStartMs);
    }
  }
  let maxSessions = 0;
  let maxSeats = 0;
  for (const t of points) {
    let sessions = 1;
    let total = seats;
    for (const a of overlapping) {
      if (a.windowStartMs <= t && t < a.windowEndMs) {
        sessions += 1;
        total += a.seats;
      }
    }
    if (sessions > maxSessions) maxSessions = sessions;
    if (total > maxSeats) maxSeats = total;
  }
  return { maxSessions, maxSeats };
}

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
 *   invitationTtlMs?: number,
 * }} options
 */
function createFileOrganizerStore(options) {
  const dataDir = options.dataDir;
  const clock = options.clock || (() => Date.now());
  const randomId = options.randomId || (() => crypto.randomUUID());
  const invitationTtlMs =
    typeof options.invitationTtlMs === "number" &&
    Number.isFinite(options.invitationTtlMs) &&
    options.invitationTtlMs > 0
      ? options.invitationTtlMs
      : INVITATION_TTL_MS;

  /** @type {Map<string, StoredApplication>} */
  const applicationsById = new Map();
  /** @type {Map<string, string[]>} */
  const applicationIdsByAccount = new Map();
  /** @type {Map<string, StoredOrganizer>} */
  const organizersById = new Map();
  /** @type {Map<string, StoredRole>} */
  const rolesByKey = new Map();
  /** @type {Map<string, StoredInvitation>} */
  const invitationsById = new Map();
  /** @type {Map<string, StoredReservation>} */
  const reservationsById = new Map();
  /** @type {Map<string, StoredEvent>} */
  const eventsById = new Map();
  /** @type {Map<string, string>} */
  const eventIdsByPublicId = new Map();
  /** @type {Map<string, StoredBoardSession>} */
  const boardSessionsById = new Map();
  /** @type {StoredAuditRecord[]} */
  const auditRecords = [];
  let loaded = false;
  let writeQueue = Promise.resolve();

  const APPLICATIONS_FILE = path.join(dataDir, "organizer_applications.json");
  const ORGANIZERS_FILE = path.join(dataDir, "organizers.json");
  const ROLES_FILE = path.join(dataDir, "organizer_roles.json");
  const INVITATIONS_FILE = path.join(dataDir, "organizer_invitations.json");
  const RESERVATIONS_FILE = path.join(dataDir, "reservations.json");
  const EVENTS_FILE = path.join(dataDir, "events.json");
  const BOARD_SESSIONS_FILE = path.join(dataDir, "board_sessions.json");
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
    const invitations = readStoreFile(INVITATIONS_FILE, { invitations: [] });
    for (const invitation of /** @type {StoredInvitation[]} */ (
      invitations.invitations || []
    )) {
      invitationsById.set(invitation.invitationId, invitation);
    }
    const reservations = readStoreFile(RESERVATIONS_FILE, { reservations: [] });
    for (const reservation of /** @type {StoredReservation[]} */ (
      reservations.reservations || []
    )) {
      reservationsById.set(reservation.reservationId, reservation);
    }
    const events = readStoreFile(EVENTS_FILE, { events: [] });
    for (const event of /** @type {StoredEvent[]} */ (events.events || [])) {
      eventsById.set(event.eventId, event);
      eventIdsByPublicId.set(event.publicId, event.eventId);
    }
    const boardSessions = readStoreFile(BOARD_SESSIONS_FILE, {
      boardSessions: [],
    });
    for (const boardSession of /** @type {StoredBoardSession[]} */ (
      boardSessions.boardSessions || []
    )) {
      boardSessionsById.set(boardSession.boardSessionId, boardSession);
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
    await writeStoreFile(INVITATIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      invitations: [...invitationsById.values()],
    });
    await writeStoreFile(RESERVATIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      reservations: [...reservationsById.values()],
    });
    await writeStoreFile(EVENTS_FILE, {
      version: STORE_FORMAT_VERSION,
      events: [...eventsById.values()],
    });
    await writeStoreFile(BOARD_SESSIONS_FILE, {
      version: STORE_FORMAT_VERSION,
      boardSessions: [...boardSessionsById.values()],
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

  // --- membership & role management ----------------------------------------

  /**
   * The role an account holds in an organizer, or null if it is not a member.
   *
   * @param {string} organizerId
   * @param {string} accountId
   * @returns {MemberRole | null}
   */
  function getMemberRole(organizerId, accountId) {
    ensureLoaded();
    return rolesByKey.get(roleKey(organizerId, accountId))?.role ?? null;
  }

  /**
   * @param {string} organizerId
   * @returns {number}
   */
  function countOwners(organizerId) {
    let owners = 0;
    for (const role of rolesByKey.values()) {
      if (role.organizerId === organizerId && role.role === "owner")
        owners += 1;
    }
    return owners;
  }

  /**
   * Members of an organizer, owners first then by grant time.
   *
   * @param {string} organizerId
   * @returns {StoredRole[]}
   */
  function listMembers(organizerId) {
    ensureLoaded();
    return [...rolesByKey.values()]
      .filter((role) => role.organizerId === organizerId)
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
        return left.grantedAtMs - right.grantedAtMs;
      });
  }

  /**
   * Organizers the account belongs to, with the account's role in each.
   *
   * @param {string} accountId
   * @returns {{organizerId: string, name: string, role: MemberRole}[]}
   */
  function listOrganizersForAccount(accountId) {
    ensureLoaded();
    return [...rolesByKey.values()]
      .filter((role) => role.accountId === accountId)
      .map((role) => ({
        organizerId: role.organizerId,
        name: organizersById.get(role.organizerId)?.name || "",
        role: role.role,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Changes an existing member's role. Owner-only in the route layer; the store
   * refuses to demote the last remaining Owner so an organizer can never be left
   * with no one able to manage it.
   *
   * @param {{organizerId: string, targetAccountId: string, newRole: MemberRole, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_member" | "last_owner" | "invalid_role"}>}
   */
  async function changeMemberRole(input) {
    ensureLoaded();
    const { organizerId, targetAccountId, newRole, actorAccountId } = input;
    if (newRole !== "owner" && newRole !== "admin") {
      return { ok: false, reason: "invalid_role" };
    }
    const key = roleKey(organizerId, targetAccountId);
    const role = rolesByKey.get(key);
    if (!role) return { ok: false, reason: "not_member" };
    if (role.role === newRole) return { ok: true };
    if (
      role.role === "owner" &&
      newRole === "admin" &&
      countOwners(organizerId) <= 1
    ) {
      return { ok: false, reason: "last_owner" };
    }
    role.role = newRole;
    recordAudit({
      actorAccountId: String(actorAccountId || ""),
      actorKind: "account",
      action: "organizer_member.role_changed",
      subjectType: "organizer_member",
      subjectId: targetAccountId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Removes a member from an organizer. Owner-only in the route layer; the last
   * remaining Owner cannot be removed. Historical Change Audit and attribution
   * are left intact.
   *
   * @param {{organizerId: string, targetAccountId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_member" | "last_owner"}>}
   */
  async function removeMember(input) {
    ensureLoaded();
    const { organizerId, targetAccountId, actorAccountId } = input;
    const key = roleKey(organizerId, targetAccountId);
    const role = rolesByKey.get(key);
    if (!role) return { ok: false, reason: "not_member" };
    if (role.role === "owner" && countOwners(organizerId) <= 1) {
      return { ok: false, reason: "last_owner" };
    }
    rolesByKey.delete(key);
    recordAudit({
      actorAccountId: String(actorAccountId || ""),
      actorKind: "account",
      action: "organizer_member.removed",
      subjectType: "organizer_member",
      subjectId: targetAccountId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  // --- invitations ---------------------------------------------------------

  /**
   * @param {StoredInvitation} invitation
   * @param {number} now
   * @returns {boolean}
   */
  function isRedeemable(invitation, now) {
    return invitation.status === "pending" && invitation.expiresAtMs > now;
  }

  /**
   * Creates a 7-day Organizer Invitation for a target email. Refuses to invite
   * an email that already belongs to a member, or to stack a second live
   * invitation for the same email in the same organizer.
   *
   * @param {{organizerId: string, email: string, role: MemberRole, invitedByAccountId: string, memberAccountId?: string | null}} input
   * @returns {Promise<{ok: true, invitation: StoredInvitation} | {ok: false, reason: "invalid_role" | "already_member" | "already_invited"}>}
   */
  async function createInvitation(input) {
    ensureLoaded();
    const { organizerId, role, invitedByAccountId } = input;
    const email = String(input.email || "")
      .trim()
      .toLowerCase()
      .slice(0, MAX_CONTACT_EMAIL_LENGTH);
    if (role !== "owner" && role !== "admin") {
      return { ok: false, reason: "invalid_role" };
    }
    // If the invitee already has an account and is already a member, there is
    // nothing to invite them to.
    if (
      input.memberAccountId &&
      rolesByKey.has(roleKey(organizerId, input.memberAccountId))
    ) {
      return { ok: false, reason: "already_member" };
    }
    const now = clock();
    for (const invitation of invitationsById.values()) {
      if (
        invitation.organizerId === organizerId &&
        invitation.email === email &&
        isRedeemable(invitation, now)
      ) {
        return { ok: false, reason: "already_invited" };
      }
    }
    /** @type {StoredInvitation} */
    const invitation = {
      invitationId: randomId(),
      organizerId,
      email,
      role,
      status: "pending",
      invitedByAccountId: String(invitedByAccountId || ""),
      createdAtMs: now,
      expiresAtMs: now + invitationTtlMs,
      acceptedByAccountId: null,
      acceptedAtMs: null,
    };
    invitationsById.set(invitation.invitationId, invitation);
    recordAudit({
      actorAccountId: invitation.invitedByAccountId,
      actorKind: "account",
      action: "organizer_invitation.created",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, invitation };
  }

  /**
   * @param {string} invitationId
   * @returns {StoredInvitation | null}
   */
  function getInvitationById(invitationId) {
    ensureLoaded();
    if (typeof invitationId !== "string" || invitationId === "") return null;
    return invitationsById.get(invitationId) || null;
  }

  /**
   * Live (pending, unexpired) invitations for an organizer, oldest first.
   *
   * @param {string} organizerId
   * @returns {StoredInvitation[]}
   */
  function listInvitationsForOrganizer(organizerId) {
    ensureLoaded();
    const now = clock();
    return [...invitationsById.values()]
      .filter(
        (invitation) =>
          invitation.organizerId === organizerId &&
          isRedeemable(invitation, now),
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  /**
   * Live invitations addressed to an email, with the organizer name resolved,
   * for the invitee's console. Never exposes organizers the account has no
   * invitation to.
   *
   * @param {string} email
   * @returns {{invitationId: string, organizerId: string, organizerName: string, role: MemberRole, expiresAtMs: number}[]}
   */
  function listPendingInvitationsForEmail(email) {
    ensureLoaded();
    const now = clock();
    const normalized = String(email || "")
      .trim()
      .toLowerCase();
    if (normalized === "") return [];
    return [...invitationsById.values()]
      .filter(
        (invitation) =>
          invitation.email === normalized && isRedeemable(invitation, now),
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map((invitation) => ({
        invitationId: invitation.invitationId,
        organizerId: invitation.organizerId,
        organizerName: organizersById.get(invitation.organizerId)?.name || "",
        role: invitation.role,
        expiresAtMs: invitation.expiresAtMs,
      }));
  }

  /**
   * Accepts an invitation. Only the account whose verified email matches the
   * invitation may accept, and only while it is still pending and unexpired.
   * The check-and-consume is synchronous, so concurrent accepts establish
   * membership exactly once. Invalid, expired, revoked, used, and
   * wrong-recipient invitations all fail identically so nothing about other
   * organizers leaks.
   *
   * @param {{invitationId: string, accountId: string, accountEmail: string}} input
   * @returns {Promise<{ok: true, organizerId: string, role: MemberRole} | {ok: false, reason: "invalid"}>}
   */
  async function acceptInvitation(input) {
    ensureLoaded();
    const invitation = invitationsById.get(String(input.invitationId || ""));
    const accountEmail = String(input.accountEmail || "")
      .trim()
      .toLowerCase();
    const now = clock();
    if (
      !invitation ||
      !isRedeemable(invitation, now) ||
      invitation.email !== accountEmail
    ) {
      return { ok: false, reason: "invalid" };
    }
    const accountId = String(input.accountId || "");
    invitation.status = "accepted";
    invitation.acceptedByAccountId = accountId;
    invitation.acceptedAtMs = now;
    // Establishing membership never downgrades an existing role: if the account
    // already holds a role (gained through another path since the invite), keep
    // it and report the real role rather than the invitation's.
    const key = roleKey(invitation.organizerId, accountId);
    const existingRole = rolesByKey.get(key);
    if (!existingRole) {
      rolesByKey.set(key, {
        organizerId: invitation.organizerId,
        accountId,
        role: invitation.role,
        grantedAtMs: now,
      });
    }
    recordAudit({
      actorAccountId: accountId,
      actorKind: "account",
      action: "organizer_invitation.accepted",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId: invitation.organizerId,
    });
    await enqueueWrite(persistNow);
    return {
      ok: true,
      organizerId: invitation.organizerId,
      role: existingRole ? existingRole.role : invitation.role,
    };
  }

  /**
   * Declines an invitation. Only the target account may decline, and only a
   * still-live invitation.
   *
   * @param {{invitationId: string, accountId: string, accountEmail: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "invalid"}>}
   */
  async function declineInvitation(input) {
    ensureLoaded();
    const invitation = invitationsById.get(String(input.invitationId || ""));
    const accountEmail = String(input.accountEmail || "")
      .trim()
      .toLowerCase();
    if (
      !invitation ||
      !isRedeemable(invitation, clock()) ||
      invitation.email !== accountEmail
    ) {
      return { ok: false, reason: "invalid" };
    }
    invitation.status = "declined";
    recordAudit({
      actorAccountId: String(input.accountId || ""),
      actorKind: "account",
      action: "organizer_invitation.declined",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId: invitation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Revokes a still-live invitation. Owner-only in the route layer.
   *
   * @param {{invitationId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "invalid"}>}
   */
  async function revokeInvitation(input) {
    ensureLoaded();
    const invitation = invitationsById.get(String(input.invitationId || ""));
    if (!invitation || invitation.status !== "pending") {
      return { ok: false, reason: "invalid" };
    }
    invitation.status = "revoked";
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "organizer_invitation.revoked",
      subjectType: "organizer_invitation",
      subjectId: invitation.invitationId,
      organizerId: invitation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Change Audit records scoped to one organizer, oldest first.
   *
   * @param {string} organizerId
   * @returns {StoredAuditRecord[]}
   */
  function listAuditForOrganizer(organizerId) {
    ensureLoaded();
    return auditRecords
      .filter((record) => record.organizerId === organizerId)
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  // --- reservations, events, board sessions & capacity ---------------------

  /**
   * @param {number} value
   * @param {number} fallback
   * @returns {number}
   */
  function integerOr(value, fallback) {
    return Number.isInteger(value) ? value : fallback;
  }

  /**
   * Creates a DRAFT reservation. Field legality (time ordering, seat range) is
   * validated by the route for per-field feedback; the store clamps strings and
   * coerces numbers defensively.
   *
   * @param {{
   *   organizerId: string,
   *   createdByAccountId: string,
   *   eventName: string,
   *   description?: string,
   *   visibility: "public" | "unlisted",
   *   startsAtMs: number,
   *   endsAtMs: number,
   *   requestedSeats: number,
   * }} input
   * @returns {Promise<{ok: true, reservation: StoredReservation}>}
   */
  async function createReservation(input) {
    ensureLoaded();
    /** @type {StoredReservation} */
    const reservation = {
      reservationId: randomId(),
      organizerId: String(input.organizerId || ""),
      eventName: clampString(input.eventName, MAX_ORGANIZER_NAME_LENGTH),
      description: clampString(input.description || "", MAX_DESCRIPTION_LENGTH),
      visibility: input.visibility === "public" ? "public" : "unlisted",
      startsAtMs: integerOr(input.startsAtMs, 0),
      endsAtMs: integerOr(input.endsAtMs, 0),
      requestedSeats: integerOr(input.requestedSeats, 0),
      status: "draft",
      createdByAccountId: String(input.createdByAccountId || ""),
      createdAtMs: clock(),
      submittedAtMs: null,
      decidedAtMs: null,
      decidedByAccountId: null,
      operatorNote: null,
      eventId: null,
    };
    reservationsById.set(reservation.reservationId, reservation);
    recordAudit({
      actorAccountId: reservation.createdByAccountId,
      actorKind: "account",
      action: "reservation.created",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, reservation };
  }

  /**
   * Overwrites the editable fields of a DRAFT reservation. Submitted or decided
   * reservations reject direct edits (they change only through a Change
   * Request).
   *
   * @param {{
   *   reservationId: string,
   *   eventName: string,
   *   description?: string,
   *   visibility: "public" | "unlisted",
   *   startsAtMs: number,
   *   endsAtMs: number,
   *   requestedSeats: number,
   * }} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_draft"}>}
   */
  async function updateReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "draft") {
      return { ok: false, reason: "not_draft" };
    }
    reservation.eventName = clampString(
      input.eventName,
      MAX_ORGANIZER_NAME_LENGTH,
    );
    reservation.description = clampString(
      input.description || "",
      MAX_DESCRIPTION_LENGTH,
    );
    reservation.visibility =
      input.visibility === "public" ? "public" : "unlisted";
    reservation.startsAtMs = integerOr(input.startsAtMs, 0);
    reservation.endsAtMs = integerOr(input.endsAtMs, 0);
    reservation.requestedSeats = integerOr(input.requestedSeats, 0);
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Transitions a DRAFT to SUBMITTED. Only a legal draft with a future start
   * may submit; after submission the approval-affecting fields are frozen.
   *
   * @param {{reservationId: string, actorAccountId: string, now: number}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_draft" | "past_start"}>}
   */
  async function submitReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "draft") {
      return { ok: false, reason: "not_draft" };
    }
    if (reservation.startsAtMs <= input.now) {
      return { ok: false, reason: "past_start" };
    }
    reservation.status = "submitted";
    reservation.submittedAtMs = clock();
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "reservation.submitted",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * Cancels a DRAFT or SUBMITTED reservation (a withdrawal). Approved
   * reservations are cancelled through the change/cancel workstream, not here.
   *
   * @param {{reservationId: string, actorAccountId: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_cancellable"}>}
   */
  async function cancelReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "draft" && reservation.status !== "submitted") {
      return { ok: false, reason: "not_cancellable" };
    }
    reservation.status = "cancelled";
    recordAudit({
      actorAccountId: String(input.actorAccountId || ""),
      actorKind: "account",
      action: "reservation.cancelled",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * The capacity window of a reservation: the buffer before its start to the
   * buffer after its end.
   *
   * @param {StoredReservation} reservation
   * @param {number} bufferMs
   * @returns {{windowStartMs: number, windowEndMs: number}}
   */
  function reservationWindow(reservation, bufferMs) {
    return {
      windowStartMs: reservation.startsAtMs - bufferMs,
      windowEndMs: reservation.endsAtMs + bufferMs,
    };
  }

  /**
   * Live Capacity Allocations: the windows and seats held by every Board
   * Session (each backs one approved reservation).
   *
   * @returns {{windowStartMs: number, windowEndMs: number, seats: number}[]}
   */
  function activeAllocations() {
    return [...boardSessionsById.values()].map((session) => ({
      windowStartMs: session.windowStartMs,
      windowEndMs: session.windowEndMs,
      seats: session.seats,
    }));
  }

  /**
   * Peak Capacity Allocation impact if a submitted reservation were approved
   * now, for the operator console. Includes the reservation itself.
   *
   * @param {{reservationId: string, bufferMs: number, sessionLimit: number, seatLimit: number}} input
   * @returns {{maxSessions: number, maxSeats: number, sessionLimit: number, seatLimit: number, wouldExceed: boolean} | null}
   */
  function capacityImpact(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return null;
    const window = reservationWindow(reservation, input.bufferMs);
    const peak = computeCapacityPeak(
      window.windowStartMs,
      window.windowEndMs,
      reservation.requestedSeats,
      activeAllocations(),
    );
    return {
      maxSessions: peak.maxSessions,
      maxSeats: peak.maxSeats,
      sessionLimit: input.sessionLimit,
      seatLimit: input.seatLimit,
      wouldExceed:
        peak.maxSessions > input.sessionLimit ||
        peak.maxSeats > input.seatLimit,
    };
  }

  /**
   * Approves a SUBMITTED reservation: checks Capacity Allocation against the
   * concurrent limits and, if it fits, atomically mints an unguessable Event
   * Public ID, creates the Event and its scheduled Board Session, and marks the
   * reservation approved. The check-and-commit is synchronous, so concurrent
   * approvals can never oversell or partially approve.
   *
   * @param {{reservationId: string, operatorAccountId: string, now: number, bufferMs: number, sessionLimit: number, seatLimit: number}} input
   * @returns {Promise<{ok: true, publicId: string, eventId: string} | {ok: false, reason: "not_found" | "not_submitted" | "past_start" | "capacity", maxSessions?: number, maxSeats?: number}>}
   */
  async function approveReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "submitted") {
      return { ok: false, reason: "not_submitted" };
    }
    // A reservation whose start has passed since submission cannot be approved
    // into the past.
    if (reservation.startsAtMs <= input.now) {
      return { ok: false, reason: "past_start" };
    }
    const window = reservationWindow(reservation, input.bufferMs);
    const peak = computeCapacityPeak(
      window.windowStartMs,
      window.windowEndMs,
      reservation.requestedSeats,
      activeAllocations(),
    );
    if (
      peak.maxSessions > input.sessionLimit ||
      peak.maxSeats > input.seatLimit
    ) {
      return {
        ok: false,
        reason: "capacity",
        maxSessions: peak.maxSessions,
        maxSeats: peak.maxSeats,
      };
    }
    const now = clock();
    const eventId = randomId();
    let publicId = randomPublicEventId();
    while (eventIdsByPublicId.has(publicId)) publicId = randomPublicEventId();
    const boardSessionId = randomId();
    eventsById.set(eventId, {
      eventId,
      publicId,
      reservationId: reservation.reservationId,
      organizerId: reservation.organizerId,
      name: reservation.eventName,
      visibility: reservation.visibility,
      startsAtMs: reservation.startsAtMs,
      endsAtMs: reservation.endsAtMs,
      createdAtMs: now,
    });
    eventIdsByPublicId.set(publicId, eventId);
    boardSessionsById.set(boardSessionId, {
      boardSessionId,
      eventId,
      reservationId: reservation.reservationId,
      organizerId: reservation.organizerId,
      status: "scheduled",
      seats: reservation.requestedSeats,
      windowStartMs: window.windowStartMs,
      windowEndMs: window.windowEndMs,
      createdAtMs: now,
    });
    reservation.status = "approved";
    reservation.decidedAtMs = now;
    reservation.decidedByAccountId = String(input.operatorAccountId || "");
    reservation.eventId = eventId;
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "reservation.approved",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true, publicId, eventId };
  }

  /**
   * Rejects a SUBMITTED reservation with an operator-only note.
   *
   * @param {{reservationId: string, operatorAccountId: string, note?: string}} input
   * @returns {Promise<{ok: true} | {ok: false, reason: "not_found" | "not_submitted"}>}
   */
  async function rejectReservation(input) {
    ensureLoaded();
    const reservation = reservationsById.get(String(input.reservationId || ""));
    if (!reservation) return { ok: false, reason: "not_found" };
    if (reservation.status !== "submitted") {
      return { ok: false, reason: "not_submitted" };
    }
    reservation.status = "rejected";
    reservation.decidedAtMs = clock();
    reservation.decidedByAccountId = String(input.operatorAccountId || "");
    reservation.operatorNote = clampString(
      input.note || "",
      MAX_OPERATOR_NOTE_LENGTH,
    );
    recordAudit({
      actorAccountId: String(input.operatorAccountId || ""),
      actorKind: "operator",
      action: "reservation.rejected",
      subjectType: "reservation",
      subjectId: reservation.reservationId,
      organizerId: reservation.organizerId,
    });
    await enqueueWrite(persistNow);
    return { ok: true };
  }

  /**
   * @param {string} reservationId
   * @returns {StoredReservation | null}
   */
  function getReservationById(reservationId) {
    ensureLoaded();
    if (typeof reservationId !== "string" || reservationId === "") return null;
    return reservationsById.get(reservationId) || null;
  }

  /**
   * Reservations of an organizer, newest first.
   *
   * @param {string} organizerId
   * @returns {StoredReservation[]}
   */
  function listReservationsForOrganizer(organizerId) {
    ensureLoaded();
    return [...reservationsById.values()]
      .filter((reservation) => reservation.organizerId === organizerId)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  /**
   * The operator review queue: submitted reservations, oldest first.
   *
   * @returns {StoredReservation[]}
   */
  function listSubmittedReservations() {
    ensureLoaded();
    return [...reservationsById.values()]
      .filter((reservation) => reservation.status === "submitted")
      .sort(
        (left, right) => (left.submittedAtMs || 0) - (right.submittedAtMs || 0),
      );
  }

  /**
   * @param {string} eventId
   * @returns {StoredEvent | null}
   */
  function getEventById(eventId) {
    ensureLoaded();
    if (typeof eventId !== "string" || eventId === "") return null;
    return eventsById.get(eventId) || null;
  }

  /**
   * @param {string} publicId
   * @returns {StoredEvent | null}
   */
  function getEventByPublicId(publicId) {
    ensureLoaded();
    const eventId = eventIdsByPublicId.get(String(publicId || ""));
    return eventId ? eventsById.get(eventId) || null : null;
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
    getMemberRole,
    listMembers,
    listOrganizersForAccount,
    changeMemberRole,
    removeMember,
    createInvitation,
    getInvitationById,
    listInvitationsForOrganizer,
    listPendingInvitationsForEmail,
    acceptInvitation,
    declineInvitation,
    revokeInvitation,
    listAuditForOrganizer,
    createReservation,
    updateReservation,
    submitReservation,
    cancelReservation,
    approveReservation,
    rejectReservation,
    capacityImpact,
    getReservationById,
    listReservationsForOrganizer,
    listSubmittedReservations,
    getEventById,
    getEventByPublicId,
    flush,
  };
}

export { createFileOrganizerStore, computeCapacityPeak };
