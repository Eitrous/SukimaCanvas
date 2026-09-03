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
import { isValidNormalizedEmail, normalizeEmail } from "../accounts/emails.mjs";
import { resolveSignedInAccountFromRequest } from "../accounts/routes.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

const MAX_ORGANIZER_NAME_LENGTH = 120;
const MAX_CONTACT_NAME_LENGTH = 120;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_OPERATOR_NOTE_LENGTH = 2000;

/** Audit action -> template translation key for the operator activity log. */
const AUDIT_ACTION_KEYS = {
  "organizer_application.submitted": "hosted_operator_audit_submitted",
  "organizer_application.approved": "hosted_operator_audit_approved",
  "organizer_application.rejected": "hosted_operator_audit_rejected",
};

/**
 * HTTP flows for Organizer Applications and the Platform Operator console.
 *
 * A verified account submits one application at a time and sees its status; a
 * Platform Operator (an account whose email is provisioned in
 * `HOSTED_OPERATOR_EMAILS`) reviews the pending queue and approves or rejects
 * each application. Approval atomically creates the Organizer and grants the
 * applicant Organizer Owner. Every input is hostile until validated, and no
 * response ever exposes the operator-only rejection note to the applicant.
 *
 * @param {{
 *   config: ServerConfig,
 *   accountStore: ReturnType<typeof import("../accounts/store.mjs").createFileAccountStore>,
 *   organizerStore: ReturnType<typeof import("./store.mjs").createFileOrganizerStore>,
 *   limiter: ReturnType<typeof import("../accounts/rate_limits.mjs").createRateLimiter>,
 *   operatorEmails: Set<string>,
 *   templates: {
 *     organizerApply: HostedTemplate,
 *     operator: HostedTemplate,
 *     operatorApplication: HostedTemplate,
 *   },
 * }} dependencies
 */
function createOrganizerRoutes(dependencies) {
  const {
    config,
    accountStore,
    organizerStore,
    limiter,
    operatorEmails,
    templates,
  } = dependencies;
  const { ensureCsrfToken, requestHasValidCsrf } = createFormSecurity(config);

  /**
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function signedInAccount(ctx) {
    return resolveSignedInAccountFromRequest(accountStore, ctx.request);
  }

  /**
   * @param {{email: string} | null} account
   * @returns {boolean}
   */
  function isOperator(account) {
    return account !== null && operatorEmails.has(account.email);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function redirectToLogin(ctx) {
    seeOther(ctx, publicPath(config, "/login"));
  }

  /**
   * @param {string} language
   * @param {number} ms
   * @returns {string}
   */
  function formatTimestamp(language, ms) {
    return new Date(ms).toLocaleString(language);
  }

  // --- applicant: organizer application ------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveOrganizerApply(ctx) {
    if (ctx.request.method === "POST") return handleApplySubmission(ctx);
    if (ctx.request.method === "GET") {
      if (!signedInAccount(ctx)) {
        redirectToLogin(ctx);
        return;
      }
      renderApplyPage(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{
   *   errorKey?: string,
   *   values?: {organizerName?: string, contactName?: string, contactEmail?: string, description?: string},
   *   submitted?: boolean,
   * }} state
   * @returns {void}
   */
  function renderApplyPage(ctx, statusCode, state) {
    const signedIn = signedInAccount(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const { language } = templates.organizerApply.translationsFor(
      ctx.request,
      ctx.url,
    );
    const view = organizerStore.getApplicantView(signedIn.accountId);
    // The form is offered when there is no application yet, or the most recent
    // one was rejected (the applicant may re-apply). A pending or approved
    // application shows status only.
    const showForm = !view || view.status === "rejected";
    const values = state.values || {};
    const csrfToken = ensureCsrfToken(ctx);
    templates.organizerApply.serveWithStatus(
      ctx.request,
      ctx.response,
      statusCode,
      {
        hostedOrganizerHasApplication: Boolean(view),
        hostedOrganizerStatus: view
          ? {
              variant: view.status,
              title: translate(
                templates.organizerApply,
                ctx,
                `hosted_organizer_status_${view.status}`,
              ),
              body: translate(
                templates.organizerApply,
                ctx,
                `hosted_organizer_status_${view.status}_body`,
                { name: view.organizerName },
              ),
              organizerName: view.organizerName,
              submittedAt: formatTimestamp(language, view.createdAtMs),
            }
          : undefined,
        hostedOrganizerShowForm: showForm,
        hostedOrganizerApplyError: state.errorKey
          ? translate(templates.organizerApply, ctx, state.errorKey)
          : undefined,
        hostedOrganizerApplySuccess: state.submitted
          ? translate(
              templates.organizerApply,
              ctx,
              "hosted_organizer_apply_success",
            )
          : undefined,
        hostedOrganizerNameValue: values.organizerName || "",
        hostedOrganizerContactNameValue: values.contactName || "",
        hostedOrganizerContactEmailValue:
          values.contactEmail || signedIn.email || "",
        hostedOrganizerDescriptionValue: values.description || "",
        csrfToken,
      },
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleApplySubmission(ctx) {
    const signedIn = signedInAccount(ctx);
    if (!signedIn) {
      redirectToLogin(ctx);
      return;
    }
    const form = await readFormBody(ctx.request);
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderApplyPage(ctx, 403, { errorKey: "hosted_error_csrf" });
      return;
    }
    const address = resolveRequestClientIpSafe(config, ctx.request);
    const limit = config.HOSTED_ORGANIZER_APPLY_ATTEMPTS_LIMIT;
    const windowMs = config.HOSTED_ORGANIZER_APPLY_ATTEMPTS_WINDOW_MS;
    const allowed =
      limiter.consume(
        "organizer_apply",
        `account:${signedIn.accountId}`,
        limit,
        windowMs,
      ).allowed &&
      limiter.consume("organizer_apply", `ip:${address}`, limit, windowMs)
        .allowed;
    if (!allowed) {
      renderApplyPage(ctx, 429, { errorKey: "hosted_error_rate_limited" });
      return;
    }

    const organizerName = (form.get("organizerName") || "").trim();
    const contactName = (form.get("contactName") || "").trim();
    const contactEmailRaw = form.get("contactEmail") || "";
    const contactEmail = normalizeEmail(contactEmailRaw);
    const description = (form.get("description") || "").trim();
    /** @type {{organizerName: string, contactName: string, contactEmail: string, description: string}} */
    const values = {
      organizerName,
      contactName,
      contactEmail: contactEmailRaw.trim(),
      description,
    };
    if (
      organizerName.length < 1 ||
      organizerName.length > MAX_ORGANIZER_NAME_LENGTH
    ) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_name",
        values,
      });
      return;
    }
    if (
      contactName.length < 1 ||
      contactName.length > MAX_CONTACT_NAME_LENGTH
    ) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_contact_name",
        values,
      });
      return;
    }
    if (
      contactEmail.length > MAX_CONTACT_EMAIL_LENGTH ||
      !isValidNormalizedEmail(contactEmail)
    ) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_contact_email",
        values,
      });
      return;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      renderApplyPage(ctx, 400, {
        errorKey: "hosted_organizer_apply_error_description",
        values,
      });
      return;
    }

    const result = await organizerStore.submitApplication({
      accountId: signedIn.accountId,
      organizerName,
      contactName,
      contactEmail,
      description,
    });
    if (!result.ok) {
      // A non-rejected application already exists: refuse deterministically and
      // re-render the current status rather than creating a conflicting
      // application or a duplicate Organizer. The pending case gets an explicit
      // message; the approved case is shown by its status card alone (this path
      // is only reachable by a direct POST, since the form is hidden then).
      renderApplyPage(ctx, 409, {
        errorKey:
          result.reason === "already_pending"
            ? "hosted_organizer_apply_error_exists"
            : undefined,
      });
      return;
    }
    logger.info("hosted.organizer_application_submitted", {
      account_id: signedIn.accountId,
      application_id: result.application.applicationId,
    });
    seeOther(ctx, `${publicPath(config, "/organizer/apply")}?submitted=1`);
  }

  // --- operator console ----------------------------------------------------

  /**
   * Resolves the request to a Platform Operator, or renders the appropriate
   * gate (login redirect for signed-out visitors, 403 for signed-in
   * non-operators) and returns null.
   *
   * @param {HttpRouteContext} ctx
   * @returns {{accountId: string, email: string, publicId: string} | null}
   */
  function requireOperator(ctx) {
    const account = signedInAccount(ctx);
    if (!account) {
      redirectToLogin(ctx);
      return null;
    }
    if (!isOperator(account)) {
      renderOperatorForbidden(ctx);
      return null;
    }
    return account;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function renderOperatorForbidden(ctx) {
    templates.operator.serveWithStatus(ctx.request, ctx.response, 403, {
      hostedOperatorForbidden: translate(
        templates.operator,
        ctx,
        "hosted_operator_forbidden",
      ),
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorConsole(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const { language } = templates.operator.translationsFor(
      ctx.request,
      ctx.url,
    );
    const pending = organizerStore
      .listPendingApplications()
      .map((application) => {
        const applicant = accountStore.getAccountById(application.accountId);
        return {
          applicationId: application.applicationId,
          organizerName: application.organizerName,
          applicantEmail: applicant ? applicant.email : "",
          submittedAt: formatTimestamp(language, application.createdAtMs),
        };
      });
    templates.operator.serveWithStatus(ctx.request, ctx.response, 200, {
      hostedOperatorPending: pending,
      hostedOperatorPendingCount: pending.length,
      hostedOperatorHasPending: pending.length > 0,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void}
   */
  function serveOperatorApplication(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    const operator = requireOperator(ctx);
    if (!operator) return;
    const application = organizerStore.getApplicationById(
      ctx.params.applicationId || "",
    );
    if (!application) throw new BoundaryError(404, "application_not_found");
    renderOperatorApplication(ctx, 200, application, {});
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {import("./store.mjs").StoredApplication} application
   * @param {{noticeKey?: string}} state
   * @returns {void}
   */
  function renderOperatorApplication(ctx, statusCode, application, state) {
    const { language } = templates.operatorApplication.translationsFor(
      ctx.request,
      ctx.url,
    );
    const applicant = accountStore.getAccountById(application.accountId);
    const decidedBy = application.decidedByAccountId
      ? accountStore.getAccountById(application.decidedByAccountId)
      : null;
    const auditView = organizerStore
      .listAuditForApplication(application.applicationId)
      .map((record) => {
        const actor = accountStore.getAccountById(record.actorAccountId);
        const actionKey =
          AUDIT_ACTION_KEYS[
            /** @type {keyof typeof AUDIT_ACTION_KEYS} */ (record.action)
          ];
        return {
          action: actionKey
            ? translate(templates.operatorApplication, ctx, actionKey)
            : record.action,
          actorEmail: actor ? actor.email : "",
          at: formatTimestamp(language, record.createdAtMs),
        };
      });
    const csrfToken = ensureCsrfToken(ctx);
    templates.operatorApplication.serveWithStatus(
      ctx.request,
      ctx.response,
      statusCode,
      {
        hostedOperatorApplicationId: application.applicationId,
        hostedOperatorApplicantEmail: applicant ? applicant.email : "",
        hostedOperatorOrganizerName: application.organizerName,
        hostedOperatorContactName: application.contactName,
        hostedOperatorContactEmail: application.contactEmail,
        hostedOperatorDescription: application.description || undefined,
        hostedOperatorStatusPending: application.status === "pending",
        hostedOperatorStatusApproved: application.status === "approved",
        hostedOperatorStatusRejected: application.status === "rejected",
        hostedOperatorDecidedBy: decidedBy ? decidedBy.email : undefined,
        hostedOperatorDecidedAt: application.decidedAtMs
          ? formatTimestamp(language, application.decidedAtMs)
          : undefined,
        // The operator-only note is shown here but never on the applicant view.
        hostedOperatorNote: application.operatorNote || undefined,
        hostedOperatorAudit: auditView,
        hostedOperatorNotice: state.noticeKey
          ? translate(templates.operatorApplication, ctx, state.noticeKey)
          : undefined,
        csrfToken,
      },
    );
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
    const form = await readFormBody(ctx.request);
    const applicationId = ctx.params.applicationId || "";
    const application = organizerStore.getApplicationById(applicationId);
    if (!application) throw new BoundaryError(404, "application_not_found");
    if (!requestHasValidCsrf(ctx.request, form)) {
      renderOperatorApplication(ctx, 403, application, {
        noticeKey: "hosted_error_csrf",
      });
      return;
    }

    const result =
      decision === "approve"
        ? await organizerStore.approveApplication({
            applicationId,
            operatorAccountId: operator.accountId,
          })
        : await organizerStore.rejectApplication({
            applicationId,
            operatorAccountId: operator.accountId,
            note: (form.get("note") || "").slice(0, MAX_OPERATOR_NOTE_LENGTH),
          });
    if (!result.ok) {
      // The application was already decided (possibly by a concurrent
      // operator): re-render its current state with a deterministic notice.
      const current =
        organizerStore.getApplicationById(applicationId) || application;
      renderOperatorApplication(ctx, 409, current, {
        noticeKey: "hosted_operator_decision_error_state",
      });
      return;
    }
    logger.info(
      `hosted.organizer_application_${decision === "approve" ? "approved" : "rejected"}`,
      {
        operator_account_id: operator.accountId,
        application_id: applicationId,
        ...("organizerId" in result
          ? { organizer_id: result.organizerId }
          : {}),
      },
    );
    seeOther(
      ctx,
      publicPath(config, `/operator/applications/${applicationId}`),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorApproveApplication(ctx) {
    return handleDecision(ctx, "approve");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  function serveOperatorRejectApplication(ctx) {
    return handleDecision(ctx, "reject");
  }

  return {
    serveOrganizerApply,
    serveOperatorConsole,
    serveOperatorApplication,
    serveOperatorApproveApplication,
    serveOperatorRejectApplication,
  };
}

export { createOrganizerRoutes };
