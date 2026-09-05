const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createSocket,
  createSocketScenario,
  resetSocketTestState,
} = require("./test_helpers.js");
const {
  createFileAccountStore,
} = require("../server/hosted_event/accounts/store.mjs");
const {
  createEventAdmission,
} = require("../server/hosted_event/admission/index.mjs");
const {
  createParticipantIdentifierResolver,
} = require("../server/hosted_event/attribution.mjs");
const {
  createFileBoardMutationLedger,
} = require("../server/hosted_event/ledger/store.mjs");
const {
  registerBoardMutationLedgerFactory,
  resetBoardMutationLedgerFactory,
} = require("../server/board/ledger_registry.mjs");
const {
  createFileOrganizerStore,
} = require("../server/hosted_event/organizers/store.mjs");
const {
  createFileEventMembershipStore,
} = require("../server/hosted_event/memberships/store.mjs");
const { MutationType } = require("../client-data/js/mutation_type.js");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ATTRIBUTION_SECRET = "attribution-test-secret";
const participantIdentifierFor =
  createParticipantIdentifierResolver(ATTRIBUTION_SECRET);

/**
 * Composes the hosted stores, admission module, and the durable mutation
 * ledger exactly like the hosted module composition does, against one shared
 * controllable clock in a temporary data directory.
 *
 * @param {number} now
 * @param {{seats?: number}} [options]
 */
async function createFixture(now, { seats = 2 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wbo-attr-"));
  const holder = { now };
  const clock = () => holder.now;
  const accountStore = createFileAccountStore({
    dataDir,
    clock,
    sessionMaxAgeMs: 1000 * DAY,
    sessionIdleMs: 1000 * DAY,
  });
  const organizerStore = createFileOrganizerStore({ dataDir, clock });
  const membershipStore = createFileEventMembershipStore({ dataDir, clock });
  const admission = createEventAdmission({
    seatGraceMs: 10 * MINUTE,
    accountStore,
    organizerStore,
    membershipStore,
    participantIdentifierFor,
    clock,
  });
  registerBoardMutationLedgerFactory((boardName) =>
    createFileBoardMutationLedger({ boardName, dataDir }),
  );
  const hostedModule = { enabled: true, ...admission };

  const owner = await provisionAccount(accountStore, "owner@example.com");
  const app = await organizerStore.submitApplication({
    accountId: owner.accountId,
    organizerName: "Aurora Collective",
    contactName: "Mika Rin",
    contactEmail: "contact@example.com",
  });
  assert.ok(app.ok);
  const approved = await organizerStore.approveApplication({
    applicationId: app.application.applicationId,
    operatorAccountId: "operator",
  });
  assert.ok(approved.ok);
  const created = await organizerStore.createReservation({
    organizerId: approved.organizerId,
    createdByAccountId: owner.accountId,
    eventName: "Attribution Jam",
    visibility: "public",
    startsAtMs: now + DAY,
    endsAtMs: now + DAY + HOUR,
    requestedSeats: seats,
  });
  assert.ok(created.ok);
  await organizerStore.submitReservation({
    reservationId: created.reservation.reservationId,
    actorAccountId: owner.accountId,
    now: 0,
  });
  const operatorApproved = await organizerStore.approveReservation({
    reservationId: created.reservation.reservationId,
    operatorAccountId: "operator",
    now: 0,
    bufferMs: 15 * MINUTE,
    sessionLimit: 20,
    seatLimit: 1000,
  });
  assert.ok(operatorApproved.ok);
  const event = organizerStore.getEventById(operatorApproved.eventId);
  assert.ok(event);
  const boardSession = organizerStore.getBoardSessionForEvent(event.eventId);
  assert.ok(boardSession);

  /**
   * @param {string} email
   */
  const addMember = async (email) => {
    const member = await provisionAccount(accountStore, email);
    await membershipStore.admit({
      eventId: event.eventId,
      accountId: member.accountId,
      anonymity: "identified",
    });
    return member;
  };

  return {
    holder,
    dataDir,
    ledgerDir: path.join(dataDir, "mutation-ledger"),
    organizerStore,
    admission,
    hostedModule,
    event,
    boardSession,
    owner: {
      ...owner,
      participantId: participantIdentifierFor(event.eventId, owner.accountId),
    },
    addMember,
  };
}

/**
 * @param {ReturnType<typeof createFileAccountStore>} accountStore
 * @param {string} email
 */
async function provisionAccount(accountStore, email) {
  const account = await accountStore.createAccount({
    email,
    passwordHash: "test-hash",
  });
  await accountStore.markAccountVerified(account.accountId, 0);
  const rawSessionId = await accountStore.createSession(account.accountId);
  return { accountId: account.accountId, rawSessionId };
}

/**
 * Connects a socket through the real hosted admission gate and connection
 * handler, exactly like the production middleware composes them.
 *
 * @param {any} scenario
 * @param {{enabled: boolean}} hostedModule
 * @param {string} boardName
 * @param {string | undefined} cookie
 * @param {string} id
 * @param {string} [baselineSeq]
 */
async function connectSocket(
  scenario,
  hostedModule,
  boardName,
  cookie,
  id,
  baselineSeq = "0",
) {
  const created = createSocket({
    id,
    remoteAddress: "203.0.113.70",
    query: { board: boardName, baselineSeq },
    handshakeHeaders: cookie ? { cookie } : {},
  });
  /** @type {any} */ (created.socket).hostedEventModule = hostedModule;
  const admission = await scenario.sockets.__test.admitHostedSocket(
    created.socket,
  );
  if (admission.ok === false) return { ok: false, reason: admission.reason };
  await scenario.sockets.__test.handleSocketConnection(
    created.socket,
    scenario.sockets.__config,
  );
  return { ok: true, created };
}

/** @param {string} rawSessionId */
const cookieFor = (rawSessionId) => `hosted-session-v1=${rawSessionId}`;

/**
 * @param {string} id
 * @param {string} clientMutationId
 * @param {{[key: string]: unknown}} [overrides]
 */
const rectangleCreate = (id, clientMutationId, overrides = {}) => ({
  tool: 3,
  type: MutationType.CREATE,
  id,
  color: "#1f2937",
  size: 10,
  x: 10,
  y: 10,
  x2: 60,
  y2: 40,
  clientMutationId,
  ...overrides,
});

/** @param {string} id */
const ellipseCreate = (id) => ({
  tool: 4,
  type: MutationType.CREATE,
  id,
  color: "#222222",
  size: 10,
  x: 0,
  y: 0,
  x2: 30,
  y2: 30,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
const lineCreate = (id) => ({
  tool: 2,
  type: MutationType.CREATE,
  id,
  color: "#333333",
  size: 10,
  x: 5,
  y: 5,
  x2: 95,
  y2: 55,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
const textCreate = (id) => ({
  tool: 5,
  type: MutationType.CREATE,
  id,
  color: "#444444",
  size: 24,
  x: 20,
  y: 40,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
const textUpdate = (id) => ({
  tool: 5,
  type: MutationType.UPDATE,
  id,
  txt: "attributed",
});

/** @param {string} id */
const pencilCreate = (id) => ({
  tool: 1,
  type: MutationType.CREATE,
  id,
  color: "#555555",
  size: 10,
  clientMutationId: `cm-${id}`,
});

/** @param {string} id */
/**
 * @param {string} id
 * @param {string} newid
 * @param {string} clientMutationId
 */
const handCopyBatch = (id, newid, clientMutationId) => ({
  tool: 7,
  clientMutationId,
  _children: [
    {
      type: MutationType.COPY,
      id,
      newid,
    },
  ],
});

/**
 * The sender's own sequenced acceptance broadcast for a mutation id.
 *
 * @param {{emitted: {event: string, payload: any}[]}} created
 * @param {string} clientMutationId
 */
function ownAcceptance(created, clientMutationId) {
  const found = created.emitted.find(
    /** @param {{event: string, payload: any}} emitted */
    (emitted) =>
      emitted.event === "broadcast" &&
      emitted.payload?.mutation?.clientMutationId === clientMutationId,
  );
  assert.ok(found, `no sequenced acceptance for ${clientMutationId}`);
  return found.payload;
}

/**
 * Reads the board's durable ledger entries straight from disk.
 *
 * @param {string} ledgerDir
 * @param {string} boardName
 */
async function readLedgerFile(ledgerDir, boardName) {
  try {
    const content = await fs.readFile(
      path.join(ledgerDir, `${boardName}.jsonl`),
      "utf8",
    );
    return content
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
}

test("every creation tool receives durable server-side attribution", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-tools-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.accountId,
      );

      // CREATE for every creation tool shape.
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-1", "cm-rect"),
      );
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        ellipseCreate("ellipse-1"),
      );
      await scenario.invoke(aliceSocket, "broadcast", lineCreate("line-1"));
      await scenario.invoke(aliceSocket, "broadcast", textCreate("text-1"));
      await scenario.invoke(aliceSocket, "broadcast", textUpdate("text-1"));
      await scenario.invoke(aliceSocket, "broadcast", pencilCreate("pencil-1"));
      // Pencil live points append to the created stroke.
      await scenario.invoke(aliceSocket, "broadcast", {
        tool: 1,
        type: MutationType.APPEND,
        parent: "pencil-1",
        x: 12,
        y: 14,
      });
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        handCopyBatch("rect-1", "rect-1-copy", "cm-copy"),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const debugRejections = aliceSocket.emitted.filter(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "mutation_rejected",
      );
      assert.deepEqual(debugRejections, []);
      for (const itemId of [
        "rect-1",
        "ellipse-1",
        "line-1",
        "text-1",
        "pencil-1",
        "rect-1-copy",
      ]) {
        const item = board.get(itemId);
        assert.ok(item, `missing item ${itemId}`);
        assert.equal(
          item.createdBy,
          aliceParticipantId,
          `${itemId} has the wrong creator`,
        );
      }
      // An APPEND extends the creator's stroke without changing attribution.
      assert.equal(board.get("pencil-1").createdBy, aliceParticipantId);

      // The acceptance broadcast carries the opaque identifier, too.
      const acceptance = ownAcceptance(aliceSocket, "cm-rect");
      assert.equal(acceptance.mutation.createdBy, aliceParticipantId);
      assert.equal(typeof acceptance.seq, "number");
      assert.equal(typeof acceptance.acceptedAtMs, "number");

      // The durable ledger records event, board session, account, time,
      // sequence, and the full attributed mutation content.
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 8);
      const rectEntry = entries.find(
        (entry) => entry.mutation.clientMutationId === "cm-rect",
      );
      assert.ok(rectEntry);
      assert.equal(rectEntry.eventId, event.eventId);
      assert.equal(rectEntry.boardSessionId, boardSession.boardSessionId);
      assert.equal(rectEntry.accountId, alice.accountId);
      assert.equal(rectEntry.seq, acceptance.seq);
      assert.equal(rectEntry.acceptedAtMs, acceptance.acceptedAtMs);
      assert.equal(rectEntry.mutation.createdBy, aliceParticipantId);
      assert.deepEqual(
        entries.map((entry) => entry.seq),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );

      // Payloads never leak the internal account id or the email.
      const payloadText = JSON.stringify(aliceSocket.emitted);
      assert.ok(!payloadText.includes(alice.accountId));
      assert.ok(!payloadText.includes("alice@example.com"));
      const svgPath = path.join(
        /** @type {string} */ (scenario.historyDir),
        `board-${event.boardName}.svg`,
      );
      await board.save();
      const storedSvg = await fs.readFile(svgPath, "utf8");
      assert.ok(
        storedSvg.includes(`data-wbo-created-by="${aliceParticipantId}"`),
      );
      assert.ok(!storedSvg.includes(alice.accountId));
    },
  );
});

test("client-supplied attribution fields are ignored by the server", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-forge-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-forge", "cm-forge", {
          createdBy: "pffffffffffffffff",
          accountId: "acct-hax",
        }),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const item = board.get("rect-forge");
      assert.ok(item);
      assert.equal(
        item.createdBy,
        participantIdentifierFor(event.eventId, alice.accountId),
      );
      // The forged fields are not stored anywhere on the item.
      assert.equal(item.accountId, undefined);
    },
  );
});

test("a copy is attributed to the copier while the source keeps its creator", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-copy-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      const bob = await fixture.addMember("bob@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const aliceConnect = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      const bobConnect = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(bob.rawSessionId),
        "socket-bob",
      );
      assert.equal(aliceConnect.ok, true);
      assert.equal(bobConnect.ok, true);
      const aliceSocket =
        aliceConnect.ok === true ? aliceConnect.created : null;
      const bobSocket = bobConnect.ok === true ? bobConnect.created : null;
      assert.ok(aliceSocket && bobSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-src", "cm-src"),
      );
      await scenario.invoke(
        bobSocket,
        "broadcast",
        handCopyBatch("rect-src", "rect-copy-bob", "cm-bob-copy"),
      );

      const board = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.accountId,
      );
      const bobParticipantId = participantIdentifierFor(
        event.eventId,
        bob.accountId,
      );
      assert.notEqual(aliceParticipantId, bobParticipantId);
      assert.equal(board.get("rect-src").createdBy, aliceParticipantId);
      assert.equal(board.get("rect-copy-bob").createdBy, bobParticipantId);

      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      const copyEntry = entries.find(
        (entry) => entry.mutation.clientMutationId === "cm-bob-copy",
      );
      assert.ok(copyEntry);
      assert.equal(copyEntry.accountId, bob.accountId);
    },
  );
});

test("a duplicate client mutation id never creates a second durable item", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-dup-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      const retry = rectangleCreate("rect-dup", "cm-dup");
      await scenario.invoke(aliceSocket, "broadcast", retry);
      await scenario.invoke(aliceSocket, "broadcast", retry);

      const first = ownAcceptance(aliceSocket, "cm-dup");
      const repeated = aliceSocket.emitted.filter(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "broadcast" &&
          emitted.payload?.mutation?.clientMutationId === "cm-dup",
      );
      // The retry is re-confirmed with the original sequence, not a new one.
      assert.ok(repeated.length >= 2);
      assert.equal(repeated[1]?.payload.seq, first.seq);

      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 1);
      const board = await scenario.getLoadedBoard(event.boardName);
      assert.ok(board.get("rect-dup"));
      assert.equal(board.getSeq(), 1);
    },
  );
});

test("a failed ledger append rejects the write and drops the mutated board instance", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-fail-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });

      registerBoardMutationLedgerFactory(() => ({
        async appendEntries() {
          throw new Error("database unavailable");
        },
        async readEntriesAfter() {
          return [];
        },
      }));

      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-lost", "cm-lost"),
      );

      const rejected = aliceSocket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) => emitted.event === "mutation_rejected",
      );
      assert.ok(rejected);
      assert.equal(rejected.payload.reason, "ledger_unavailable");
      assert.equal(rejected.payload.clientMutationId, "cm-lost");
      // The stale instance is dropped: the connection cannot keep serving
      // state that the durable ledger never confirmed.
      assert.equal(aliceSocket.socket.disconnected, true);

      // Nothing durable was recorded anywhere.
      const entries = await readLedgerFile(fixture.ledgerDir, event.boardName);
      assert.equal(entries.length, 0);

      // A fresh load with a healthy ledger has no trace of the mutation.
      registerBoardMutationLedgerFactory((boardName) =>
        createFileBoardMutationLedger({
          boardName,
          dataDir: fixture.dataDir,
        }),
      );
      const reconnected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-2",
      );
      assert.equal(reconnected.ok, true);
      const board = await scenario.getLoadedBoard(event.boardName);
      assert.equal(board.get("rect-lost"), undefined);
      assert.equal(board.getSeq(), 0);
      const reSocket = reconnected.ok === true ? reconnected.created : null;
      assert.ok(reSocket);
      const replayBatch = reSocket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "broadcast" &&
          emitted.payload?.type === MutationType.BATCH,
      );
      assert.ok(replayBatch);
      assert.equal(replayBatch.payload.seq, 0);
      assert.deepEqual(replayBatch.payload._children, []);
    },
  );
});

test("a board reload catches up from the ledger past the stored SVG snapshot", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-reload-" },
    async (scenario) => {
      const fixture = await createFixture(Date.now());
      const { event, hostedModule, boardSession } = fixture;
      const alice = await fixture.addMember("alice@example.com");
      fixture.holder.now = boardSession.startsAtMs;
      await fixture.organizerStore.advanceLifecycle({
        now: fixture.holder.now,
      });
      const connected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice",
      );
      assert.equal(connected.ok, true);
      const aliceSocket = connected.ok === true ? connected.created : null;
      assert.ok(aliceSocket);

      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-snap", "cm-snap"),
      );
      const board = await scenario.getLoadedBoard(event.boardName);
      await board.save();
      const snapshotSeq = board.getSeq();

      // Accepted writes after the snapshot exist only in the ledger.
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        rectangleCreate("rect-lag", "cm-lag"),
      );
      await scenario.invoke(
        aliceSocket,
        "broadcast",
        handCopyBatch("rect-lag", "rect-lag-copy", "cm-lag-copy"),
      );
      const lagSeq = board.getSeq();
      assert.equal(lagSeq, snapshotSeq + 2);

      // Reload from disk: snapshot plus ledger replay. A client whose
      // baseline is the snapshot seq replays the lagging mutations from the
      // hydrated log; anything older refreshes its baseline, exactly like
      // the legacy unload behavior.
      await resetSocketTestState(scenario.sockets);
      const reconnected = await connectSocket(
        scenario,
        hostedModule,
        event.boardName,
        cookieFor(alice.rawSessionId),
        "socket-alice-2",
        String(snapshotSeq),
      );
      assert.equal(reconnected.ok, true);
      const reloaded = await scenario.getLoadedBoard(event.boardName);
      const aliceParticipantId = participantIdentifierFor(
        event.eventId,
        alice.accountId,
      );
      assert.equal(reloaded.get("rect-snap").createdBy, aliceParticipantId);
      assert.equal(reloaded.get("rect-lag").createdBy, aliceParticipantId);
      assert.equal(reloaded.get("rect-lag-copy").createdBy, aliceParticipantId);
      assert.equal(reloaded.getSeq(), lagSeq);

      // The reconnecting socket replays the post-snapshot mutations from the
      // hydrated log, so late joiners see continuous history.
      const reSocket = reconnected.ok === true ? reconnected.created : null;
      assert.ok(reSocket);
      const replayBatch = reSocket.emitted.find(
        /** @param {{event: string, payload: any}} emitted */
        (emitted) =>
          emitted.event === "broadcast" &&
          emitted.payload?.type === MutationType.BATCH,
      );
      assert.ok(replayBatch);
      assert.equal(replayBatch.payload.fromSeq, snapshotSeq);
      assert.equal(replayBatch.payload.seq, lagSeq);
      assert.equal(replayBatch.payload._children.length, lagSeq - snapshotSeq);
      const replayedCreate = replayBatch.payload._children.find(
        /** @param {any} child */
        (child) => child.clientMutationId === "cm-lag",
      );
      assert.ok(replayedCreate);
      assert.equal(replayedCreate.createdBy, aliceParticipantId);
    },
  );
});

test("legacy boards keep their in-memory-only behavior", async () => {
  await createSocketScenario(
    { historyDirPrefix: "wbo-attr-legacy-" },
    async (scenario) => {
      const connected = await scenario.connect({
        id: "legacy-writer",
        query: { board: "legacy-board" },
      });
      await scenario.invoke(
        connected,
        "broadcast",
        rectangleCreate("legacy-rect", "cm-legacy"),
      );
      const board = await scenario.getLoadedBoard("legacy-board");
      const item = board.get("legacy-rect");
      assert.ok(item);
      // No hosted admission on a legacy socket: no operator, no attribution.
      assert.equal(item.createdBy, undefined);
      const acceptance = ownAcceptance(connected, "cm-legacy");
      assert.equal(acceptance.mutation.createdBy, undefined);
    },
  );
  resetBoardMutationLedgerFactory();
});
