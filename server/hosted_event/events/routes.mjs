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
import { formatServiceTime } from "../service_time.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";
import {
  eventLifecycleState,
  MAX_EVENT_TAGLINE_LENGTH,
} from "../organizers/store.mjs";
import { sniffImage } from "../assets/image_validation.mjs";
import { readMultipartFormData } from "../assets/upload.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

/** Event lifecycle state -> translation key for a display badge. */
const EVENT_STATUS_KEYS = {
  scheduled: "hosted_event_status_scheduled",
  open: "hosted_event_status_open",
  ended: "hosted_event_status_ended",
};

/**
 * HTTP flows for Event discovery and Brand Asset display.
 *
 * Visitors discover public, still-live events on the home page or open an
 * unlisted event through its unguessable Public ID; before an Access Code is
 * verified the event page exposes only the event's name, the organizer's
 * display name, its cover, its times, and a lifecycle status — never capacity,
 * participants, or administrative data. Organizer Owners/Admins toggle
 * visibility and manage the event's public display and its cover Brand Asset.
 * Brand Assets are only ever stored after real image decoding and are served
 * through a controlled read path that can never become an executable page.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("../organizers/store.mjs").createFileOrganizerStore>,
 *   assetStore: ReturnType<typeof import("../assets/store.mjs").createFileBrandAssetStore>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   templates: {
 *     home: HostedTemplate,
 *     event: HostedTemplate,
 *     organizerEvent: HostedTemplate,
 *   },
 *   clock?: () => number,
 * }} dependencies
 */
function createEventRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    assetStore,
    limiter,
    templates,
  } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);
  const offsetMinutes = config.HOSTED_SERVICE_UTC_OFFSET_MINUTES;

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string} | null}
   */
  function signedInAccount(ctx) {
    return resolveSignedInAccountFromRequest(accountStore, ctx.request);
  }

  /**
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(ms) {
    return formatServiceTime(ms, offsetMinutes);
  }

  // --- public discovery ----------------------------------------------------

  /**
   * The Hosted home page. Lists only public, not-yet-ended events; unlisted and
   * ended events never appear here.
   *
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveHome(ctx) {
    const template = templates.home;
    const events = organizerStore
      .listPublicDiscoverableEvents(clock())
      .map((event) => ({
        name: event.name,
        organizerName:
          organizerStore.getOrganizerById(event.organizerId)?.name || "",
        tagline: event.tagline || undefined,
        startsAt: formatTimestamp(event.startsAtMs),
        href: `events/${event.publicId}`,
        coverHref: event.coverAssetId
          ? `assets/${event.coverAssetId}`
          : undefined,
      }));
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedEvents: events,
      hostedHasEvents: events.length > 0,
    });
  }

  /**
   * The participant-facing event page reached through the Public ID. Before an
   * Access Code is verified this deliberately renders only public, non-sensitive
   * fields.
   *
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveEventPage(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const event = organizerStore.getEventByPublicId(ctx.params.publicId || "");
    // A missing or unknown Public ID is an ordinary 404: the id space is
    // unguessable, and listing status is never confirmed here.
    if (!event) throw new BoundaryError(404, "event_not_found");
    const template = templates.event;
    const organizer = organizerStore.getOrganizerById(event.organizerId);
    const lifecycle = eventLifecycleState(event, clock());
    template.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedEventName: event.name,
      hostedEventOrganizerName: organizer ? organizer.name : "",
      hostedEventTagline: event.tagline || undefined,
      hostedEventCoverHref: event.coverAssetId
        ? `assets/${event.coverAssetId}`
        : undefined,
      hostedEventStartsAt: formatTimestamp(event.startsAtMs),
      hostedEventEndsAt: formatTimestamp(event.endsAtMs),
      hostedEventStatusLabel: translate(
        template,
        ctx,
        EVENT_STATUS_KEYS[lifecycle],
      ),
      hostedEventScheduled: lifecycle === "scheduled",
      hostedEventOpen: lifecycle === "open",
      hostedEventEnded: lifecycle === "ended",
    });
  }

  /**
   * The controlled Brand Asset read path. Serves stored image bytes with the
   * sniffed content type, `nosniff`, and a locked-down CSP so an asset can never
   * be interpreted as an executable or script-bearing page, and never exposes
   * the internal object key.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveBrandAsset(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const assetId = ctx.params.assetId || "";
    const asset = assetStore.getAsset(assetId);
    if (!asset) throw new BoundaryError(404, "asset_not_found");
    const bytes = await assetStore.readAssetBytes(assetId);
    if (!bytes) throw new BoundaryError(404, "asset_not_found");
    ctx.response.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": bytes.length,
      // An uploaded image must never be sniffed into another type, executed, or
      // treated as an active document.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": config.IS_DEVELOPMENT
        ? "no-store"
        : "public, max-age=31536000, immutable",
    });
    ctx.response.end(bytes);
  }

  // --- organizer event management ------------------------------------------

  /**
   * Resolves the signed-in Owner/Admin member for an organizer's event.
   * Signed-out visitors are redirected to login (returns null); a signed-in
   * non-member, an unknown organizer, or an event that is not this organizer's
   * all 404 so nothing about other organizers or events leaks.
   *
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {string} eventId
   * @returns {{account: {accountId: string, email: string}, event: import("../organizers/store.mjs").StoredEvent} | null}
   */
  function requireManagedEvent(ctx, organizerId, eventId) {
    const account = signedInAccount(ctx);
    if (!account) {
      seeOther(ctx, publicPath(config, "/login"));
      return null;
    }
    const role = organizerStore.getMemberRole(organizerId, account.accountId);
    if (!role || !organizerStore.getOrganizerById(organizerId)) {
      throw new BoundaryError(404, "organizer_not_found");
    }
    const event = organizerStore.getEventForOrganizer(organizerId, eventId);
    if (!event) throw new BoundaryError(404, "event_not_found");
    return { account, event };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerEvent(ctx) {
    if (ctx.request.method === "POST") return handleUpdateEvent(ctx);
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    renderManageEvent(ctx, organizerId, managed.event, 200, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} organizerId
   * @param {import("../organizers/store.mjs").StoredEvent} event
   * @param {number} statusCode
   * @param {{errorKey?: string, noticeKey?: string}} state
   * @returns {void}
   */
  function renderManageEvent(ctx, organizerId, event, statusCode, state) {
    const template = templates.organizerEvent;
    const lifecycle = eventLifecycleState(event, clock());
    template.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedOrganizerId: organizerId,
      hostedEventId: event.eventId,
      hostedEventName: event.name,
      hostedEventReservationId: event.reservationId,
      hostedEventPublicPath: publicPath(config, `/events/${event.publicId}`),
      hostedEventPublicHref: `events/${event.publicId}`,
      hostedEventVisibilityPublic: event.visibility === "public",
      hostedEventTaglineValue: event.tagline || "",
      hostedEventCoverHref: event.coverAssetId
        ? `assets/${event.coverAssetId}`
        : undefined,
      hostedEventHasCover: Boolean(event.coverAssetId),
      hostedEventStartsAt: formatTimestamp(event.startsAtMs),
      hostedEventEndsAt: formatTimestamp(event.endsAtMs),
      hostedEventStatusLabel: translate(
        template,
        ctx,
        EVENT_STATUS_KEYS[lifecycle],
      ),
      hostedEventTaglineMax: MAX_EVENT_TAGLINE_LENGTH,
      hostedEventManageError: state.errorKey
        ? translate(template, ctx, state.errorKey)
        : undefined,
      hostedEventManageNotice: state.noticeKey
        ? translate(template, ctx, state.noticeKey)
        : undefined,
      csrfToken: ensureCsrfToken(ctx),
    });
  }

  /**
   * Updates visibility + tagline, or clears the cover, from the urlencoded
   * management form. Owner/Admin only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleUpdateEvent(ctx) {
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    const tagline = (form.get("tagline") || "").trim();
    if (tagline.length > MAX_EVENT_TAGLINE_LENGTH) {
      renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_error_tagline",
      });
      return;
    }
    const visibility =
      form.get("visibility") === "public" ? "public" : "unlisted";
    const removeCover = form.get("removeCover") === "1";
    const previousCoverId = managed.event.coverAssetId;
    await organizerStore.updateEventDisplay({
      organizerId,
      eventId: managed.event.eventId,
      visibility,
      tagline,
      removeCover,
      actorAccountId: managed.account.accountId,
    });
    // Clearing the cover also deletes its bytes so the superseded image cannot
    // still be fetched through the controlled read path.
    if (removeCover && previousCoverId) {
      await assetStore.deleteAsset(previousCoverId);
    }
    logger.info("hosted.event_display_updated", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  /**
   * Accepts a cover Brand Asset upload. The declared MIME type is ignored: the
   * bytes must decode as a real PNG/JPEG/WebP within the size cap. Owner/Admin
   * only.
   *
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function serveOrganizerEventCover(ctx) {
    if (ctx.request.method !== "POST") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const organizerId = ctx.params.organizerId || "";
    const managed = requireManagedEvent(
      ctx,
      organizerId,
      ctx.params.eventId || "",
    );
    if (!managed) return;
    // Throttle before reading the (up to multi-MiB) upload body, using the
    // session-derived account and the client IP — neither needs the body.
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_BRAND_ASSET_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_BRAND_ASSET_ATTEMPTS_WINDOW_MS;
    if (
      !limiter.consume(
        "brand_asset",
        `account:${managed.account.accountId}`,
        limit,
        windowMs,
      ).allowed ||
      !limiter.consume("brand_asset", `ip:${address}`, limit, windowMs).allowed
    ) {
      renderManageEvent(ctx, organizerId, managed.event, 429, {
        errorKey: "hosted_error_rate_limited",
      });
      return;
    }
    const upload = await readMultipartFormData(ctx.request);
    const csrfForm = new URLSearchParams({
      _csrf: upload.fields._csrf || "",
    });
    if (!requestHasValidCsrf(ctx.request, csrfForm)) {
      renderManageEvent(ctx, organizerId, managed.event, 403, {
        errorKey: "hosted_error_csrf",
      });
      return;
    }
    if (!upload.file || upload.file.bytes.length === 0) {
      renderManageEvent(ctx, organizerId, managed.event, 400, {
        errorKey: "hosted_event_cover_error_invalid",
      });
      return;
    }
    const sniffed = sniffImage(upload.file.bytes);
    if (!sniffed.ok) {
      const errorKey =
        sniffed.reason === "too_large"
          ? "hosted_event_cover_error_too_large"
          : "hosted_event_cover_error_type";
      renderManageEvent(ctx, organizerId, managed.event, 400, { errorKey });
      return;
    }
    const previousCoverId = managed.event.coverAssetId;
    const stored = await assetStore.putAsset({
      kind: "event_cover",
      organizerId,
      eventId: managed.event.eventId,
      format: sniffed.format,
      contentType: sniffed.contentType,
      bytes: upload.file.bytes,
    });
    await organizerStore.setEventCover({
      organizerId,
      eventId: managed.event.eventId,
      assetId: stored.assetId,
      actorAccountId: managed.account.accountId,
    });
    // Drop the replaced cover's bytes now that the event points at the new one.
    if (previousCoverId && previousCoverId !== stored.assetId) {
      await assetStore.deleteAsset(previousCoverId);
    }
    logger.info("hosted.event_cover_set", {
      organizer_id: organizerId,
      event_id: managed.event.eventId,
      format: sniffed.format,
    });
    seeOther(
      ctx,
      publicPath(
        config,
        `/organizers/${organizerId}/events/${managed.event.eventId}`,
      ),
    );
  }

  return {
    serveHome,
    serveEventPage,
    serveBrandAsset,
    serveOrganizerEvent,
    serveOrganizerEventCover,
  };
}

export { createEventRoutes };
