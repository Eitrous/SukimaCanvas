import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as productionConfig from "./configuration.mjs";
import { route, routeHttpRequests } from "./http/dispatch.mjs";
import observability from "./observability/index.mjs";
import {
  downloadBoard,
  rejectMissingBoardName,
  serveBoardPreview,
  serveBoardSvg,
} from "./routes/board_assets.mjs";
import { redirectBoardQuery, serveBoardPage } from "./routes/board_page.mjs";
import {
  serveAccount,
  serveAccountPassword,
  serveAccountSessionRevoke,
  serveAccountSessionsRevokeOthers,
  serveBrandAsset,
  serveEventPage,
  serveForgot,
  serveLogin,
  serveLogout,
  serveCancelReservation,
  serveOperatorApplication,
  serveOperatorApproveApplication,
  serveOperatorApproveReservation,
  serveOperatorConsole,
  serveOperatorRejectApplication,
  serveOperatorRejectReservation,
  serveOperatorReservation,
  serveOperatorReservations,
  serveOrganizerApply,
  serveOrganizerConsole,
  serveOrganizerInvitationAccept,
  serveOrganizerInvitationDecline,
  serveOrganizerInvitationRevoke,
  serveOrganizerInvite,
  serveOrganizerEvent,
  serveOrganizerEventCover,
  serveOrganizerManage,
  serveOrganizerMemberRemove,
  serveOrganizerMemberRole,
  serveOrganizerReservation,
  serveOrganizerReservations,
  serveRegister,
  serveReset,
  serveSubmitReservation,
  serveVerify,
} from "./routes/hosted_pages.mjs";
import {
  redirectToRandomBoard,
  serveBoardStaticAsset,
  serveManifest,
  serveRulesPage,
  serveRoot,
  serveSource,
  serveStaticAsset,
} from "./routes/static.mjs";
import { startWhiteboardServer } from "./runtime/boot.mjs";
import { createServerRuntime } from "./runtime/create_runtime.mjs";
import * as sockets from "./socket/index.mjs";

const { logger } = observability;

/** @import { ServerConfig, SocketServerModule } from "../types/server-runtime.d.ts" */

/** @param {string | undefined} value */
const hasDot = (value) => typeof value === "string" && value.includes(".");

/**
 * @returns {import("../types/server-runtime.d.ts").HttpRequestHandler}
 */
function createWhiteboardHttpHandler() {
  return routeHttpRequests([
    route("/boards", redirectBoardQuery, "boards_redirect"),
    route("/boards/", rejectMissingBoardName, "board_page"),
    route("/boards/{board}.svg", serveBoardSvg, "board_svg"),
    route("/boards/{asset}", serveBoardStaticAsset, "static_file", {
      where: (params) => hasDot(params.asset),
    }),
    route("/boards/{board}", serveBoardPage, "board_page", {
      where: (params) => !hasDot(params.board),
    }),
    ...boardNameRouteGroup("/download", downloadBoard, "download_board"),
    ...boardNameRouteGroup("/preview", serveBoardPreview, "preview_board"),
    ...boardNameRouteGroup("/export", serveBoardPreview, "preview_board", {
      access: "user",
    }),
    route("/random", redirectToRandomBoard, "random_board", {
      access: "user",
    }),
    route("/rules", serveRulesPage, "rules"),
    route("/source", serveSource, "source"),
    route("/register", serveRegister, "hosted_register"),
    route("/login", serveLogin, "hosted_login"),
    route("/verify", serveVerify, "hosted_verify"),
    route("/logout", serveLogout, "hosted_logout"),
    route("/forgot", serveForgot, "hosted_forgot"),
    route("/reset", serveReset, "hosted_reset"),
    route("/account", serveAccount, "hosted_account"),
    route("/account/password", serveAccountPassword, "hosted_account_password"),
    route(
      "/account/sessions/revoke",
      serveAccountSessionRevoke,
      "hosted_account_session_revoke",
    ),
    route(
      "/account/sessions/revoke-others",
      serveAccountSessionsRevokeOthers,
      "hosted_account_sessions_revoke_others",
    ),
    route("/organizer", serveOrganizerConsole, "hosted_organizer_console"),
    route("/organizer/apply", serveOrganizerApply, "hosted_organizer_apply"),
    route(
      "/organizer/invitations/{invitationId}/accept",
      serveOrganizerInvitationAccept,
      "hosted_organizer_invitation_accept",
    ),
    route(
      "/organizer/invitations/{invitationId}/decline",
      serveOrganizerInvitationDecline,
      "hosted_organizer_invitation_decline",
    ),
    route(
      "/organizers/{organizerId}",
      serveOrganizerManage,
      "hosted_organizer_manage",
    ),
    route(
      "/organizers/{organizerId}/invitations",
      serveOrganizerInvite,
      "hosted_organizer_invite",
    ),
    route(
      "/organizers/{organizerId}/invitations/{invitationId}/revoke",
      serveOrganizerInvitationRevoke,
      "hosted_organizer_invitation_revoke",
    ),
    route(
      "/organizers/{organizerId}/members/{accountId}/role",
      serveOrganizerMemberRole,
      "hosted_organizer_member_role",
    ),
    route(
      "/organizers/{organizerId}/members/{accountId}/remove",
      serveOrganizerMemberRemove,
      "hosted_organizer_member_remove",
    ),
    route(
      "/organizers/{organizerId}/reservations",
      serveOrganizerReservations,
      "hosted_organizer_reservations",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}",
      serveOrganizerReservation,
      "hosted_organizer_reservation",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}/submit",
      serveSubmitReservation,
      "hosted_organizer_reservation_submit",
    ),
    route(
      "/organizers/{organizerId}/reservations/{reservationId}/cancel",
      serveCancelReservation,
      "hosted_organizer_reservation_cancel",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}",
      serveOrganizerEvent,
      "hosted_organizer_event",
    ),
    route(
      "/organizers/{organizerId}/events/{eventId}/cover",
      serveOrganizerEventCover,
      "hosted_organizer_event_cover",
    ),
    route("/operator", serveOperatorConsole, "hosted_operator"),
    route(
      "/operator/reservations",
      serveOperatorReservations,
      "hosted_operator_reservations",
    ),
    route(
      "/operator/reservations/{reservationId}",
      serveOperatorReservation,
      "hosted_operator_reservation",
    ),
    route(
      "/operator/reservations/{reservationId}/approve",
      serveOperatorApproveReservation,
      "hosted_operator_reservation_approve",
    ),
    route(
      "/operator/reservations/{reservationId}/reject",
      serveOperatorRejectReservation,
      "hosted_operator_reservation_reject",
    ),
    route(
      "/operator/applications/{applicationId}",
      serveOperatorApplication,
      "hosted_operator_application",
    ),
    route(
      "/operator/applications/{applicationId}/approve",
      serveOperatorApproveApplication,
      "hosted_operator_application_approve",
    ),
    route(
      "/operator/applications/{applicationId}/reject",
      serveOperatorRejectApplication,
      "hosted_operator_application_reject",
    ),
    route("/events/{publicId}", serveEventPage, "hosted_event_page"),
    route("/assets/{assetId}", serveBrandAsset, "hosted_brand_asset"),
    route("/manifest.json", serveManifest, "manifest"),
    route("/", serveRoot, "index"),
    route("*", serveStaticAsset, "static_file"),
  ]);
}

/**
 * @param {string} prefix
 * @param {import("../types/server-runtime.d.ts").HttpRouteHandler} handler
 * @param {string} routeName
 * @param {{access?: "none" | "user"}=} options
 */
function boardNameRouteGroup(prefix, handler, routeName, options) {
  return [
    route(`${prefix}/{board}`, handler, routeName, options),
    ...missingBoardNameRoutes(prefix, routeName, options),
  ];
}

/**
 * @param {string} prefix
 * @param {string} routeName
 * @param {{access?: "none" | "user"}=} options
 */
function missingBoardNameRoutes(prefix, routeName, options) {
  return [
    route(prefix, rejectMissingBoardName, routeName, options),
    route(`${prefix}/`, rejectMissingBoardName, routeName, options),
  ];
}

/**
 * @param {ServerConfig} config
 * @param {{
 *   installShutdownHandlers?: boolean,
 *   logStarted?: boolean,
 *   socketsModule?: SocketServerModule,
 * }} [options]
 * @returns {Promise<import("../types/server-runtime.d.ts").ServerApp>}
 */
async function createServerApp(config, options = {}) {
  return startWhiteboardServer(config, {
    runtime: createServerRuntime,
    http: createWhiteboardHttpHandler(),
    sockets: options.socketsModule || sockets,
    installShutdownHandlers: options.installShutdownHandlers,
    logStarted: options.logStarted,
  });
}

const entryArg = process.argv[1];
if (entryArg && path.resolve(entryArg) === fileURLToPath(import.meta.url)) {
  void createServerApp(productionConfig, {
    installShutdownHandlers: true,
  }).catch((error) => {
    logger.error("server.start_failed", {
      error,
    });
    process.exit(1);
  });
}

export { createServerApp };
