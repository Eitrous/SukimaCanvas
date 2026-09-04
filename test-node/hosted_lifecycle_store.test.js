const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");

const HOUR = 60 * 60 * 1000;
const BUFFER = 15 * 60 * 1000;
const DRAIN = 60 * 1000;

/** @returns {Promise<string>} */
function createDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wbo-hosted-lifecycle-"));
}

/**
 * A mutable-clock store: mutate `holder.now` and the store sees the new time.
 *
 * @param {string} dataDir
 * @param {{now: number}} holder
 */
function makeStore(dataDir, holder) {
  return createFileOrganizerStore({ dataDir, clock: () => holder.now });
}

/**
 * @param {ReturnType<typeof createFileOrganizerStore>} store
 * @returns {Promise<string>}
 */
async function setupOrganizer(store) {
  const submitted = await store.submitApplication({
    accountId: "owner-1",
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "owner@example.com",
    description: "Jams.",
  });
  assert.ok(submitted.ok);
  const approved = await store.approveApplication({
    applicationId: submitted.application.applicationId,
    operatorAccountId: "operator-1",
  });
  assert.ok(approved.ok);
  return approved.organizerId;
}

/**
 * Approves a reservation and returns its ids.
 *
 * @param {ReturnType<typeof createFileOrganizerStore>} store
 * @param {string} organizerId
 * @param {number} now
 * @param {{startsAtMs: number, endsAtMs: number, seats: number, seatLimit?: number}} fields
 */
async function approveReservation(store, organizerId, now, fields) {
  const created = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: "Event",
    visibility: "public",
    startsAtMs: fields.startsAtMs,
    endsAtMs: fields.endsAtMs,
    requestedSeats: fields.seats,
  });
  assert.ok(created.ok);
  await store.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: "owner-1",
    now,
  });
  const approved = await store.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator-1",
    now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: fields.seatLimit ?? 1000,
  });
  assert.ok(approved.ok);
  return {
    reservationId: created.reservation.reservationId,
    eventId: approved.eventId,
    publicId: approved.publicId,
  };
}

test("advanceLifecycle moves a session scheduled -> open -> closing -> closed by time", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const end = start + HOUR;
  const { reservationId } = await approveReservation(
    store,
    organizerId,
    holder.now,
    {
      startsAtMs: start,
      endsAtMs: end,
      seats: 20,
    },
  );
  const status = () =>
    store.getBoardSessionForReservation(reservationId)?.status;
  assert.equal(status(), "scheduled");

  // Before the start, nothing advances.
  assert.deepEqual(
    await store.advanceLifecycle({ now: start - 1, closeDrainMs: DRAIN }),
    [],
  );
  assert.equal(status(), "scheduled");

  holder.now = start;
  const opened = await store.advanceLifecycle({
    now: start,
    closeDrainMs: DRAIN,
  });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.to, "open");
  assert.equal(status(), "open");
  // Idempotent: the same tick applies nothing more.
  assert.deepEqual(
    await store.advanceLifecycle({ now: start, closeDrainMs: DRAIN }),
    [],
  );

  holder.now = end;
  await store.advanceLifecycle({ now: end, closeDrainMs: DRAIN });
  assert.equal(status(), "closing"); // drain not elapsed yet

  holder.now = end + DRAIN;
  await store.advanceLifecycle({ now: end + DRAIN, closeDrainMs: DRAIN });
  assert.equal(status(), "closed");

  // Terminal: no further transitions.
  assert.deepEqual(
    await store.advanceLifecycle({ now: end + 10 * HOUR, closeDrainMs: DRAIN }),
    [],
  );
});

test("interrupted lifecycle work resumes after a restart and catches up", async () => {
  const holder = { now: 1_000_000 };
  const dataDir = await createDataDir();
  const store = makeStore(dataDir, holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const end = start + HOUR;
  const { reservationId } = await approveReservation(
    store,
    organizerId,
    holder.now,
    {
      startsAtMs: start,
      endsAtMs: end,
      seats: 20,
    },
  );
  // Advance only to open, then "crash" (flush and drop the instance).
  holder.now = start;
  await store.advanceLifecycle({ now: start, closeDrainMs: DRAIN });
  await store.flush();

  // A fresh instance, well past the end + drain, catches up in one pass.
  const later = { now: end + DRAIN + HOUR };
  const reloaded = makeStore(dataDir, later);
  const transitions = await reloaded.advanceLifecycle({
    now: later.now,
    closeDrainMs: DRAIN,
  });
  assert.deepEqual(
    transitions.map((t) => t.to),
    ["closing", "closed"],
  );
  assert.equal(
    reloaded.getBoardSessionForReservation(reservationId)?.status,
    "closed",
  );
  // Re-running after recovery is a no-op (no duplicate transitions).
  assert.deepEqual(
    await reloaded.advanceLifecycle({ now: later.now, closeDrainMs: DRAIN }),
    [],
  );
});

test("cancelling a future event releases its capacity and hides it, keeping audit", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const end = start + HOUR;
  const a = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: end,
    seats: 30,
    seatLimit: 50,
  });

  // An overlapping 30-seat reservation cannot be approved at a 50-seat limit.
  const bCreated = await store.createReservation({
    organizerId,
    createdByAccountId: "owner-1",
    eventName: "Overlap",
    visibility: "public",
    startsAtMs: start,
    endsAtMs: end,
    requestedSeats: 30,
  });
  await store.submitReservation({
    reservationId: bCreated.reservation.reservationId,
    actorAccountId: "owner-1",
    now: holder.now,
  });
  const blocked = await store.approveReservation({
    reservationId: bCreated.reservation.reservationId,
    operatorAccountId: "operator-1",
    now: holder.now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 50,
  });
  assert.ok(blocked.ok === false && blocked.reason === "capacity");

  const auditBefore = store.listAuditForOrganizer(organizerId).length;
  // Cancel A: releases its future capacity, hides it, and preserves audit.
  const cancelled = await store.cancelApprovedEvent({
    reservationId: a.reservationId,
    organizerId,
    actorAccountId: "owner-1",
    now: holder.now,
  });
  assert.ok(cancelled.ok);
  assert.equal(store.getReservationById(a.reservationId)?.status, "cancelled");
  assert.equal(store.getEventById(a.eventId)?.status, "cancelled");
  assert.deepEqual(store.listPublicDiscoverableEvents(holder.now), []);
  const auditAfter = store.listAuditForOrganizer(organizerId);
  assert.ok(
    auditAfter.length > auditBefore,
    "audit is appended, never deleted",
  );
  assert.ok(auditAfter.some((r) => r.action === "event.cancelled"));

  // Now B fits, because A's allocation was released.
  const nowApproved = await store.approveReservation({
    reservationId: bCreated.reservation.reservationId,
    operatorAccountId: "operator-1",
    now: holder.now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 50,
  });
  assert.ok(nowApproved.ok);
});

test("a started event can no longer be cancelled", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const a = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: start + HOUR,
    seats: 20,
  });
  holder.now = start;
  await store.advanceLifecycle({ now: start, closeDrainMs: DRAIN });
  const result = await store.cancelApprovedEvent({
    reservationId: a.reservationId,
    organizerId,
    actorAccountId: "owner-1",
    now: start,
  });
  assert.deepEqual(result, { ok: false, reason: "not_future" });
});

test("an amend is applied only after operator approval, re-running capacity", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const end = start + HOUR;
  const a = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: end,
    seats: 30,
  });

  const submitted = await store.submitChangeRequest({
    reservationId: a.reservationId,
    organizerId,
    proposedStartsAtMs: start,
    proposedEndsAtMs: end,
    proposedSeats: 45,
    requestedByAccountId: "owner-1",
  });
  assert.ok(submitted.ok);
  // The reservation is unchanged until approval.
  assert.equal(store.getReservationById(a.reservationId)?.requestedSeats, 30);
  // Only one pending at a time.
  const second = await store.submitChangeRequest({
    reservationId: a.reservationId,
    organizerId,
    proposedStartsAtMs: start,
    proposedEndsAtMs: end,
    proposedSeats: 40,
    requestedByAccountId: "owner-1",
  });
  assert.deepEqual(second, { ok: false, reason: "already_pending" });

  const applied = await store.approveChangeRequest({
    changeRequestId: submitted.changeRequest.changeRequestId,
    operatorAccountId: "operator-1",
    now: holder.now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(applied.ok);
  assert.equal(store.getReservationById(a.reservationId)?.requestedSeats, 45);
  assert.equal(store.getBoardSessionForReservation(a.reservationId)?.seats, 45);
});

test("an amend that would exceed capacity is refused and leaves state unchanged", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const end = start + HOUR;
  await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: end,
    seats: 30,
    seatLimit: 50,
  });
  const b = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: end,
    seats: 15,
    seatLimit: 50,
  });
  // Amend B from 15 -> 30: peak with A(30) would be 60 > 50.
  const submitted = await store.submitChangeRequest({
    reservationId: b.reservationId,
    organizerId,
    proposedStartsAtMs: start,
    proposedEndsAtMs: end,
    proposedSeats: 30,
    requestedByAccountId: "owner-1",
  });
  assert.ok(submitted.ok);
  const impact = store.changeRequestCapacityImpact({
    changeRequestId: submitted.changeRequest.changeRequestId,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 50,
  });
  assert.ok(impact && impact.wouldExceed && impact.maxSeats === 60);
  const refused = await store.approveChangeRequest({
    changeRequestId: submitted.changeRequest.changeRequestId,
    operatorAccountId: "operator-1",
    now: holder.now,
    bufferMs: BUFFER,
    sessionLimit: 20,
    seatLimit: 50,
  });
  assert.ok(refused.ok === false && refused.reason === "capacity");
  // Unchanged: B still 15, and the request is still pending.
  assert.equal(store.getBoardSessionForReservation(b.reservationId)?.seats, 15);
  assert.equal(
    store.getChangeRequestById(submitted.changeRequest.changeRequestId)?.status,
    "pending",
  );
});

test("concurrent amend approvals never oversell", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const end = start + HOUR;
  const a = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: end,
    seats: 15,
    seatLimit: 50,
  });
  const b = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: end,
    seats: 15,
    seatLimit: 50,
  });
  /** @param {string} reservationId */
  const amend = async (reservationId) => {
    const submitted = await store.submitChangeRequest({
      reservationId,
      organizerId,
      proposedStartsAtMs: start,
      proposedEndsAtMs: end,
      proposedSeats: 30,
      requestedByAccountId: "owner-1",
    });
    assert.ok(submitted.ok);
    return submitted.changeRequest.changeRequestId;
  };
  const idA = await amend(a.reservationId);
  const idB = await amend(b.reservationId);
  /** @param {string} changeRequestId */
  const approve = (changeRequestId) =>
    store.approveChangeRequest({
      changeRequestId,
      operatorAccountId: "operator-1",
      now: holder.now,
      bufferMs: BUFFER,
      sessionLimit: 20,
      seatLimit: 50,
    });
  const [ra, rb] = await Promise.all([approve(idA), approve(idB)]);
  const oks = [ra.ok, rb.ok].filter(Boolean).length;
  // A(30) alone is 30 <= 50; both at 30 would be 60 > 50, so exactly one wins.
  assert.equal(oks, 1);
});

test("amend and reject are rejected once the session is no longer scheduled", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const a = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: start + HOUR,
    seats: 20,
  });
  const submitted = await store.submitChangeRequest({
    reservationId: a.reservationId,
    organizerId,
    proposedStartsAtMs: start,
    proposedEndsAtMs: start + HOUR,
    proposedSeats: 25,
    requestedByAccountId: "owner-1",
  });
  assert.ok(submitted.ok);
  const rejected = await store.rejectChangeRequest({
    changeRequestId: submitted.changeRequest.changeRequestId,
    operatorAccountId: "operator-1",
    note: "Not this time.",
  });
  assert.ok(rejected.ok);
  assert.equal(
    store.getChangeRequestById(submitted.changeRequest.changeRequestId)?.status,
    "rejected",
  );

  // After the session opens, a new amend cannot be submitted.
  holder.now = start;
  await store.advanceLifecycle({ now: start, closeDrainMs: DRAIN });
  const late = await store.submitChangeRequest({
    reservationId: a.reservationId,
    organizerId,
    proposedStartsAtMs: start,
    proposedEndsAtMs: start + 2 * HOUR,
    proposedSeats: 20,
    requestedByAccountId: "owner-1",
  });
  assert.deepEqual(late, { ok: false, reason: "not_scheduled" });
});

test("cancelling supersedes a pending amend with an audited rejection", async () => {
  const holder = { now: 1_000_000 };
  const store = makeStore(await createDataDir(), holder);
  const organizerId = await setupOrganizer(store);
  const start = holder.now + HOUR;
  const a = await approveReservation(store, organizerId, holder.now, {
    startsAtMs: start,
    endsAtMs: start + HOUR,
    seats: 20,
  });
  const submitted = await store.submitChangeRequest({
    reservationId: a.reservationId,
    organizerId,
    proposedStartsAtMs: start,
    proposedEndsAtMs: start + HOUR,
    proposedSeats: 25,
    requestedByAccountId: "owner-1",
  });
  assert.ok(submitted.ok);

  const cancelled = await store.cancelApprovedEvent({
    reservationId: a.reservationId,
    organizerId,
    actorAccountId: "owner-1",
    now: holder.now,
  });
  assert.ok(cancelled.ok);

  // The superseded amend is rejected with the cancelling actor and audited.
  const request = store.getChangeRequestById(
    submitted.changeRequest.changeRequestId,
  );
  assert.equal(request?.status, "rejected");
  assert.equal(request?.decidedByAccountId, "owner-1");
  const rejections = store
    .listAuditForOrganizer(organizerId)
    .filter(
      (record) =>
        record.action === "change_request.rejected" &&
        record.subjectId === submitted.changeRequest.changeRequestId,
    );
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.actorAccountId, "owner-1");
});
