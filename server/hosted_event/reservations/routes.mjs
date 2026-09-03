import observability from "../../observability/index.mjs";
import { BoundaryError } from "../../http/boundary_errors.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { publicPath } from "../../http/request_url.mjs";
import {
  createFormSecurity,
  readFormBody,
  seeOther,
  translate,
} from "../http_forms.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

const MAX_EVENT_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;

/** Reservation status -> translation key for a display badge. */
const STATUS_LABEL_KEYS = {
  draft: "hosted_reservation_status_draft",
  submitted: "hosted_reservation_status_submitted",
  approved: "hosted_reservation_status_approved",
  rejected: "hosted_reservation_status_rejected",
  cancelled: "hosted_reservation_status_cancelled",
};

/**
 * The `±HH:MM` ISO representation of a UTC offset in minutes.
 *
 * @param {number} offsetMinutes
 * @returns {string}
 */
function offsetIso(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * Parses an HTML datetime-local value (`YYYY-MM-DDTHH:MM`), interpreted as a
 * wall-clock time in the fixed service timezone, into a UTC epoch ms.
 *
 * @param {string | null} value
 * @param {number} offsetMinutes
 * @returns {number | null}
 */
function parseDateTimeLocal(value, offsetMinutes) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const ms = Date.parse(
    `${match[1]}${match[2] || ":00"}.000${offsetIso(offsetMinutes)}`,
  );
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Renders a UTC epoch ms as a datetime-local form value in the service
 * timezone (so the edit field round-trips through parseDateTimeLocal).
 *
 * @param {number} ms
 * @param {number} offsetMinutes
 * @returns {string}
 */
function toDateTimeLocal(ms, offsetMinutes) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms + offsetMinutes * 60000).toISOString().slice(0, 16);
}

/**
 * Renders a UTC epoch ms as a human-readable time in the service timezone,
 * consistent with the datetime-local edit fields.
 *
 * @param {number} ms
 * @param {number} offsetMinutes
 * @returns {string}
 */
function formatServiceTime(ms, offsetMinutes) {
  if (!(Number.isFinite(ms) && ms > 0)) return "";
  const shifted = new Date(ms + offsetMinutes * 60000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} (UTC${offsetIso(offsetMinutes)})`;
}

/**
 * HTTP flows for Reservations and their Platform Operator approval.
 *
 * Organizer members (owner or admin) draft, edit, and submit reservations;
 * after submission the approval-affecting fields are frozen. A Platform Operator
 * approves — within the concurrent capacity limits, minting an unguessable Event
 * Public ID — or rejects. All inputs are hostile until validated and every
 * failure is deterministic.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   operatorEmails: Set<string>,
 *   templates: {
 *     organizerReservations: HostedTemplate,
 *     organizerReservation: HostedTemplate,
 *     operatorReservations: HostedTemplate,
 *     operatorReservation: HostedTemplate,
 *   },
 *   clock?: () => number,
 * }} dependencies
 */
function createReservationRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    limiter,
    operatorEmails,
    templates,
  } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);
  const offsetMinutes = config.HOSTED_SERVICE_UTC_OFFSET_MINUTES;

  const capacityOptions = () => ({
    bufferMs: config.HOSTED_CAPACITY_WINDOW_BUFFER_MS,
    sessionLimit: config.HOSTED_MAX_CONCURRENT_BOARD_SESSIONS,
    seatLimit: config.HOSTED_MAX_CONCURRENT_SEATS,
  });

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function signedInAccount(ctx) {
    return resolveSignedInAccountFromRequest(accountStore, ctx.request);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function redirectToLogin(ctx) {
    seeOther(ctx, publicPath(config, "/login"));
  }

  /**
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(ms) {
    return formatServiceTime(ms, offsetMinutes);
  }

  /**
   * Resolves the signed-in account's membership in an organizer. Signed-out ->
   * login redirect (returns null); signed-in non-member -> 404 so the
   * organizer's existence is not disclosed.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @returns {{accountId: string, email: string} | null}
   */
  function requireMember(ctx, organizerId) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return null;
    }
    const role = organizerStore.getMemberRole(organizerId, account.accountId);
    if (!role || !organizerStore.getOrganizerById(organizerId)) {
      throw new BoundaryError(404, "organizer_not_found");
    }
    return account;
  }

  /**
   * Resolves a Platform Operator. Signed-out -> login redirect; signed-in
   * non-operator -> 403.
   *
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string} | null}
   */
  function requireOperator(ctx) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return null;
    }
    if (!operatorEmails.has(account.email)) {
      throw new BoundaryError(403, "operator_required");
    }
    return account;
  }

  /**
   * Validates reservation form input. `requireFuture` additionally requires the
   * start to be in the future (enforced at submit).
   *
   * @param {URLSearchParams} form
   * @param {{requireFuture: boolean, now: number}} options
   * @returns {{ok: true, parsed: {eventName: string, description: string, visibility: "public" | "unlisted", startsAtMs: number, endsAtMs: number, requestedSeats: number}} | {ok: false, errorKey: string}}
   */
  function validateReservation(form, options) {
    const eventName = (form.get("eventName") || "").trim();
    if (eventName.length < 1 || eventName.length > MAX_EVENT_NAME_LENGTH) {
      return { ok: false, errorKey: "hosted_reservation_error_name" };
    }
    const startsAtMs = parseDateTimeLocal(form.get("startsAt"), offsetMinutes);
    const endsAtMs = parseDateTimeLocal(form.get("endsAt"), offsetMinutes);
    if (startsAtMs === null || endsAtMs === null) {
      return { ok: false, errorKey: "hosted_reservation_error_time" };
    }
    if (endsAtMs <= startsAtMs) {
      return { ok: false, errorKey: "hosted_reservation_error_time_order" };
    }
    if (endsAtMs - startsAtMs > config.HOSTED_MAX_EVENT_DURATION_MS) {
      return { ok: false, errorKey: "hosted_reservation_error_duration" };
    }
    if (options.requireFuture && startsAtMs <= options.now) {
      return { ok: false, errorKey: "hosted_reservation_error_past" };
    }
    const seatsRaw = (form.get("requestedSeats") || "").trim();
    const requestedSeats = Number.parseInt(seatsRaw, 10);
    if (
      !/^\d+$/.test(seatsRaw) ||
      requestedSeats < 1 ||
      requestedSeats > config.HOSTED_MAX_RESERVATION_SEATS
    ) {
      return { ok: false, errorKey: "hosted_reservation_error_seats" };
    }
    const description = (form.get("description") || "").trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, errorKey: "hosted_reservation_error_description" };
    }
    return {
      ok: true,
      parsed: {
        eventName,
        description,
        visibility: form.get("visibility") === "public" ? "public" : "unlisted",
        startsAtMs,
        endsAtMs,
        requestedSeats,
      },
    };
  }

  // --- organizer reservation management ------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerReservations(ctx) {
    if (ctx.request.method === "POST") return handleCreateReservation(ctx);
    if (ctx.request.method === "GET") {
      const organizerId = ctx.params.organizerId || "";
      const account = requireMember(ctx, organizerId);
      if (!account) return;
      renderReservationList(ctx, organizerId, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {number} statusCode
   * @param {{errorKey?: string, values?: {[key: string]: string}}} state
   * @returns {void}
   */
  function renderReservationList(ctx, organizerId, statusCode, state) {
    const template = templates.organizerReservations;
    const organizer = organizerStore.getOrganizerById(organizerId);
    if (!organizer) throw new BoundaryError(404, "organizer_not_found");
    const reservations = organizerStore
      .listReservationsForOrganizer(organizerId)
      .map((reservation) => ({
        reservationId: reservation.reservationId,
        eventName: reservation.eventName,
        statusLabel: translate(
          template,
          ctx,
          STATUS_LABEL_KEYS[reservation.status],
        ),
        startsAt: formatTimestamp(reservation.startsAtMs),
        requestedSeats: reservation.requestedSeats,
      }));
    const values = state.values || {};
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedOrganizerName: organizer.name,
      hostedReservations: reservations,
      hostedHasReservations: reservations.length > 0,
      hostedReservationError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      hostedReservationSeatMax: config.HOSTED_MAX_RESERVATION_SEATS,
      hostedReservationNameValue: values.eventName || "",
      hostedReservationStartValue: values.startsAt || "",
      hostedReservationEndValue: values.endsAt || "",
      hostedReservationSeatsValue: values.requestedSeats || "",
      hostedReservationDescriptionValue: values.description || "",
      hostedReservationVisibilityPublic: values.visibility === "public",
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {URLSearchParams} form
   * @returns {{[key: string]: string}}
   */
  function echoValues(form) {
    return {
      visibility: form.get("visibility") === "public" ? "public" : "unlisted",
      eventName: (form.get("eventName") || "").trim(),
      startsAt: (form.get("startsAt") || "").trim(),
      endsAt: (form.get("endsAt") || "").trim(),
      requestedSeats: (form.get("requestedSeats") || "").trim(),
      description: (form.get("description") || "").trim(),
    };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} accountId
   * @returns {boolean}
   */
  function withinRateLimit(ctx, accountId) {
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_RESERVATION_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_RESERVATION_ATTEMPTS_WINDOW_MS;
    return (
      limiter.consume("reservation", `account:${accountId}`, limit, windowMs)
        .allowed &&
      limiter.consume("reservation", `ip:${address}`, limit, windowMs).allowed
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleCreateReservation(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationList(ctx, organizerId, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!withinRateLimit(ctx, account.accountId)) {
      renderReservationList(ctx, organizerId, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    const validation = validateReservation(form, {
      requireFuture: false,
      now: clock(),
    });
    if (!validation.ok) {
      renderReservationList(ctx, organizerId, 400, {
        errorKey: validation.errorKey,
        values: echoValues(form),
      });
      return;
    }
    const created = await organizerStore.createReservation({
      organizerId,
      createdByAccountId: account.accountId,
      ...validation.parsed,
    });
    logger.info("hosted.reservation_created", {
      organizer_id: organizerId,
      reservation_id: created.reservation.reservationId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${created.reservation.reservationId}`,
      ),
    );
  }

  /**
   * Loads a reservation that belongs to the organizer in the path, or 404.
   *
   * @param {string} organizerId
   * @param {string} reservationId
   * @returns {import("../organizers/store.mjs").StoredReservation}
   */
  function loadOwnedReservation(organizerId, reservationId) {
    const reservation = organizerStore.getReservationById(reservationId);
    if (!reservation || reservation.organizerId !== organizerId) {
      throw new BoundaryError(404, "reservation_not_found");
    }
    return reservation;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerReservation(ctx) {
    if (ctx.request.method === "POST") return handleUpdateReservation(ctx);
    if (ctx.request.method === "GET") {
      const organizerId = ctx.params.organizerId || "";
      const account = requireMember(ctx, organizerId);
      if (!account) return;
      const reservation = loadOwnedReservation(
        organizerId,
        ctx.params.reservationId || "",
      );
      renderReservationDetail(ctx, organizerId, reservation, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {import("../organizers/store.mjs").StoredReservation} reservation
   * @param {number} statusCode
   * @param {{errorKey?: string}} state
   * @returns {void}
   */
  function renderReservationDetail(
    ctx,
    organizerId,
    reservation,
    statusCode,
    state,
  ) {
    const template = templates.organizerReservation;
    const event = reservation.eventId
      ? organizerStore.getEventById(reservation.eventId)
      : null;
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedReservationId: reservation.reservationId,
      hostedReservationName: reservation.eventName,
      hostedReservationDescription: reservation.description || undefined,
      hostedReservationStatusLabel: translate(
        template,
        ctx,
        STATUS_LABEL_KEYS[reservation.status],
      ),
      hostedReservationIsDraft: reservation.status === "draft",
      hostedReservationIsSubmitted: reservation.status === "submitted",
      hostedReservationIsApproved: reservation.status === "approved",
      hostedReservationIsRejected: reservation.status === "rejected",
      hostedReservationCancellable:
        reservation.status === "draft" || reservation.status === "submitted",
      hostedReservationVisibilityPublic: reservation.visibility === "public",
      hostedReservationStartValue: toDateTimeLocal(
        reservation.startsAtMs,
        offsetMinutes,
      ),
      hostedReservationEndValue: toDateTimeLocal(
        reservation.endsAtMs,
        offsetMinutes,
      ),
      hostedReservationStartAt: formatTimestamp(reservation.startsAtMs),
      hostedReservationEndAt: formatTimestamp(reservation.endsAtMs),
      hostedReservationSeats: reservation.requestedSeats,
      hostedReservationSeatMax: config.HOSTED_MAX_RESERVATION_SEATS,
      hostedReservationVisibilityLabel: translate(
        template,
        ctx,
        reservation.visibility === "public"
          ? "hosted_reservation_visibility_public"
          : "hosted_reservation_visibility_unlisted",
      ),
      hostedReservationEventPublicPath: event
        ? publicPath(config, `/events/${event.publicId}`)
        : undefined,
      hostedReservationError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleUpdateReservation(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (reservation.status !== "draft") {
      // Approval-affecting fields are frozen after submission.
      renderReservationDetail(ctx, organizerId, reservation, 409, {
        errorKey: "hosted_reservation_error_locked",
      });
      return;
    }
    const validation = validateReservation(form, {
      requireFuture: false,
      now: clock(),
    });
    if (!validation.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 400, {
        errorKey: validation.errorKey,
      });
      return;
    }
    await organizerStore.updateReservation({
      reservationId: reservation.reservationId,
      ...validation.parsed,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveSubmitReservation(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!withinRateLimit(ctx, account.accountId)) {
      renderReservationDetail(ctx, organizerId, reservation, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    // Re-validate the stored draft (structural legality + future start) before
    // freezing it for approval.
    const validation = validateReservation(
      new URLSearchParams({
        eventName: reservation.eventName,
        startsAt: toDateTimeLocal(reservation.startsAtMs, offsetMinutes),
        endsAt: toDateTimeLocal(reservation.endsAtMs, offsetMinutes),
        requestedSeats: String(reservation.requestedSeats),
        visibility: reservation.visibility,
        description: reservation.description,
      }),
      { requireFuture: true, now: clock() },
    );
    if (!validation.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 400, {
        errorKey: validation.errorKey,
      });
      return;
    }
    const result = await organizerStore.submitReservation({
      reservationId: reservation.reservationId,
      actorAccountId: account.accountId,
      now: clock(),
    });
    if (!result.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 409, {
        errorKey: "hosted_reservation_error_not_draft",
      });
      return;
    }
    logger.info("hosted.reservation_submitted", {
      organizer_id: organizerId,
      reservation_id: reservation.reservationId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveCancelReservation(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const account = requireMember(ctx, organizerId);
    if (!account) return;
    const reservation = loadOwnedReservation(
      organizerId,
      ctx.params.reservationId || "",
    );
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderReservationDetail(ctx, organizerId, reservation, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const result = await organizerStore.cancelReservation({
      reservationId: reservation.reservationId,
      actorAccountId: account.accountId,
    });
    if (!result.ok) {
      renderReservationDetail(ctx, organizerId, reservation, 409, {
        errorKey: "hosted_reservation_error_not_cancellable",
      });
      return;
    }
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/reservations/${reservation.reservationId}`,
      ),
    );
  }

  // --- operator reservation review -----------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorReservations(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    // Rendered through the operator-reservation template's queue mode.
    renderOperatorQueue(ctx);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function renderOperatorQueue(ctx) {
    const template = templates.operatorReservations;
    const pending = organizerStore
      .listSubmittedReservations()
      .map((reservation) => {
        const organizer = organizerStore.getOrganizerById(
          reservation.organizerId,
        );
        return {
          reservationId: reservation.reservationId,
          organizerName: organizer ? organizer.name : "",
          eventName: reservation.eventName,
          startsAt: formatTimestamp(reservation.startsAtMs),
          requestedSeats: reservation.requestedSeats,
        };
      });
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedOperatorReservations: pending,
      hostedOperatorHasReservations: pending.length > 0,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorReservation(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const reservation = organizerStore.getReservationById(
      ctx.params.reservationId || "",
    );
    if (!reservation) throw new BoundaryError(404, "reservation_not_found");
    renderOperatorReservation(ctx, reservation, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {import("../organizers/store.mjs").StoredReservation} reservation
   * @param {number} statusCode
   * @param {{noticeKey?: string}} state
   * @returns {void}
   */
  function renderOperatorReservation(ctx, reservation, statusCode, state) {
    const template = templates.operatorReservation;
    const organizer = organizerStore.getOrganizerById(reservation.organizerId);
    const impact =
      reservation.status === "submitted"
        ? organizerStore.capacityImpact({
            reservationId: reservation.reservationId,
            ...capacityOptions(),
          })
        : null;
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedReservationId: reservation.reservationId,
      hostedReservationOrganizerName: organizer ? organizer.name : "",
      hostedReservationName: reservation.eventName,
      hostedReservationDescription: reservation.description || undefined,
      hostedReservationStartAt: formatTimestamp(reservation.startsAtMs),
      hostedReservationEndAt: formatTimestamp(reservation.endsAtMs),
      hostedReservationSeats: reservation.requestedSeats,
      hostedReservationStatusLabel: translate(
        template,
        ctx,
        STATUS_LABEL_KEYS[reservation.status],
      ),
      hostedReservationIsSubmitted: reservation.status === "submitted",
      hostedReservationVisibilityLabel: translate(
        template,
        ctx,
        reservation.visibility === "public"
          ? "hosted_reservation_visibility_public"
          : "hosted_reservation_visibility_unlisted",
      ),
      hostedCapacity: impact
        ? {
            sessions: impact.maxSessions,
            sessionLimit: impact.sessionLimit,
            seats: impact.maxSeats,
            seatLimit: impact.seatLimit,
            wouldExceed: impact.wouldExceed,
          }
        : undefined,
      hostedOperatorReservationNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {"approve" | "reject"} decision
   * @returns {Promise<void>}
   */
  async function handleDecision(ctx, decision) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const reservation = organizerStore.getReservationById(
      ctx.params.reservationId || "",
    );
    if (!reservation) throw new BoundaryError(404, "reservation_not_found");
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorReservation(ctx, reservation, 403, {
        noticeKey: "hosted_error_csrf",
      });
      return;
    }
    if (decision === "approve") {
      const result = await organizerStore.approveReservation({
        reservationId: reservation.reservationId,
        operatorAccountId: operator.accountId,
        now: clock(),
        ...capacityOptions(),
      });
      if (!result.ok) {
        const current =
          organizerStore.getReservationById(reservation.reservationId) ||
          reservation;
        const noticeKey =
          result.reason === "capacity"
            ? "hosted_operator_reservation_capacity_conflict"
            : result.reason === "past_start"
              ? "hosted_operator_reservation_past_start"
              : "hosted_operator_reservation_not_submitted";
        renderOperatorReservation(ctx, current, 409, { noticeKey });
        return;
      }
      logger.info("hosted.reservation_approved", {
        operator_account_id: operator.accountId,
        reservation_id: reservation.reservationId,
        event_id: result.eventId,
      });
    } else {
      const result = await organizerStore.rejectReservation({
        reservationId: reservation.reservationId,
        operatorAccountId: operator.accountId,
        note: (form.get("note") || "").slice(0, MAX_OPERATOR_NOTE_LENGTH),
      });
      if (!result.ok) {
        const current =
          organizerStore.getReservationById(reservation.reservationId) ||
          reservation;
        renderOperatorReservation(ctx, current, 409, {
          noticeKey: "hosted_operator_reservation_not_submitted",
        });
        return;
      }
      logger.info("hosted.reservation_rejected", {
        operator_account_id: operator.accountId,
        reservation_id: reservation.reservationId,
      });
    }
    seeOther(
      ctx,
      publicPath(config, `/operator/reservations/${reservation.reservationId}`),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorApproveReservation(ctx) {
    return handleDecision(ctx, "approve");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorRejectReservation(ctx) {
    return handleDecision(ctx, "reject");
  }

  return {
    serveOrganizerReservations,
    serveOrganizerReservation,
    serveSubmitReservation,
    serveCancelReservation,
    serveOperatorReservations,
    serveOperatorReservation,
    serveOperatorApproveReservation,
    serveOperatorRejectReservation,
  };
}

export { createReservationRoutes };
