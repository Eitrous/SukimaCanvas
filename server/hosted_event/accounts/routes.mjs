import observability from "../../observability/index.mjs";
import { BoundaryError, badRequest } from "../../http/boundary_errors.mjs";
import { resolveRequestClientIpSafe } from "../../socket/policy.mjs";
import { requestScheme } from "../../http/observation.mjs";
import { publicPath } from "../../http/request_url.mjs";
import {
  parseCookieHeader,
  appendSetCookieHeader,
} from "../../auth/user_secret_cookie.mjs";
import {
  HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS,
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_SESSION_COOKIE_NAME,
  clearHostedCookie,
  generateHostedToken,
  hostedCookiePath,
  readHostedCookie,
  serializeHostedCookie,
  timingSafeEqualStrings,
} from "../../auth/hosted_cookies.mjs";
import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";
import {
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
} from "./passwords.mjs";

const { logger } = observability;

/** @import { HttpRequest, HttpResponse, HttpRouteContext, ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * A hosted page template: the shared Template plus the hosted-only status
 * entry point used by the account flows.
 *
 * @typedef {import("../../http/templating.mjs").Template & {
 *   serveWithStatus: (request: HttpRequest, response: HttpResponse, statusCode: number, extraParams?: object) => {encoding?: unknown},
 * }} HostedTemplate
 */

const MAX_FORM_BODY_BYTES = 32 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * HTTP flows for hosted accounts: registration with email verification,
 * login, and logout. All inputs are hostile until validated; every failure is
 * a deterministic rendered response or boundary error, never a crash, and no
 * response, log line, or email ever carries a password, a password hash, or a
 * verification token.
 *
 * @param {{
 *   config: ServerConfig,
 *   store: ReturnType<typeof import("./store.mjs").createFileAccountStore>,
 *   mail: {send: (message: {to: string, subject: string, body: string}) => Promise<void>},
 *   captcha: ReturnType<typeof import("./captcha.mjs").createHostedCaptcha>,
 *   limiter: ReturnType<typeof import("./rate_limits.mjs").createRateLimiter>,
 *   templates: {
 *     register: HostedTemplate,
 *     login: HostedTemplate,
 *     verify: HostedTemplate,
 *     logout: HostedTemplate,
 *   },
 *   clock?: () => number,
 * }} dependencies
 */
function createHostedAccountRoutes(dependencies) {
  const { config, store, mail, captcha, limiter, templates } = dependencies;
  const clock = dependencies.clock || (() => Date.now());
  const secureCookies = config.IS_DEVELOPMENT !== true;
  const cookieOptions = () => ({
    path: hostedCookiePath(config),
    secure: secureCookies,
  });

  /**
   * Returns the browser's CSRF token, issuing a fresh one (with its cookie)
   * when the request does not carry one yet.
   *
   * @param {HttpRouteContext} ctx
   * @returns {string}
   */
  function ensureCsrfToken(ctx) {
    const existing = readHostedCookie(
      ctx.request.headers.cookie,
      HOSTED_CSRF_COOKIE_NAME,
    );
    if (existing) return existing;
    const token = generateHostedToken();
    appendSetCookieHeader(
      ctx.response,
      serializeHostedCookie(HOSTED_CSRF_COOKIE_NAME, token, {
        ...cookieOptions(),
        maxAgeSeconds: HOSTED_CSRF_COOKIE_MAX_AGE_SECONDS,
      }),
    );
    return token;
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {string}
   */
  function clientIp(ctx) {
    // Falls back to the direct remote address when the configured IP source
    // (for example X-Forwarded-For) is absent on a direct connection.
    return resolveRequestClientIpSafe(config, ctx.request);
  }

  /**
   * @param {import("../../http/templating.mjs").Template} template
   * @param {HttpRouteContext} ctx
   * @param {string} key
   * @param {{[name: string]: string}} [substitutions]
   * @returns {string}
   */
  function translate(template, ctx, key, substitutions) {
    const { translations } = template.translationsFor(ctx.request, ctx.url);
    let value = translations[key];
    if (typeof value !== "string" || value === "") value = key;
    for (const [name, replacement] of Object.entries(substitutions || {})) {
      value = value.split(`{${name}}`).join(replacement);
    }
    return value;
  }

  /**
   * @param {import("http").IncomingMessage} request
   * @returns {Promise<URLSearchParams>}
   */
  async function readFormBody(request) {
    const contentType = firstHeaderValue(request.headers["content-type"]);
    if (
      typeof contentType !== "string" ||
      !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
    ) {
      throw new BoundaryError(415, "unsupported_form_media_type");
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_FORM_BODY_BYTES) {
        throw new BoundaryError(413, "form_body_too_large");
      }
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  /**
   * @param {URLSearchParams} form
   * @param {{[name: string]: string}} cookies
   * @returns {boolean}
   */
  function hasValidCsrf(form, cookies) {
    const submitted = form.get("_csrf");
    const expected = cookies[HOSTED_CSRF_COOKIE_NAME];
    return (
      typeof submitted === "string" &&
      submitted.length >= 16 &&
      typeof expected === "string" &&
      expected.length >= 16 &&
      timingSafeEqualStrings(submitted, expected)
    );
  }

  /**
   * @param {string} kind
   * @param {string} clientAddress
   * @param {string} emailKey
   * @returns {boolean}
   */
  function consumeAttemptLimits(kind, clientAddress, emailKey) {
    const limit =
      kind === "register"
        ? config.HOSTED_REGISTER_ATTEMPTS_LIMIT
        : config.HOSTED_LOGIN_ATTEMPTS_LIMIT;
    const windowMs =
      kind === "register"
        ? config.HOSTED_REGISTER_ATTEMPTS_WINDOW_MS
        : config.HOSTED_LOGIN_ATTEMPTS_WINDOW_MS;
    return (
      limiter.consume(kind, `ip:${clientAddress}`, limit, windowMs).allowed &&
      limiter.consume(kind, `email:${emailKey}`, limit, windowMs).allowed
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} rawToken
   * @returns {string}
   */
  function buildVerificationUrl(ctx, rawToken) {
    const authority =
      firstHeaderValue(ctx.request.headers["x-forwarded-host"]) ||
      firstHeaderValue(ctx.request.headers.host);
    try {
      const url = new URL(
        `${requestScheme(ctx.request)}://${authority || ""}${config.BASE_PATH}/verify`,
      );
      url.searchParams.set("token", rawToken);
      return url.href;
    } catch {
      throw badRequest("invalid_request_host");
    }
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} rawSessionId
   * @returns {void}
   */
  function issueSessionCookie(ctx, rawSessionId) {
    appendSetCookieHeader(
      ctx.response,
      serializeHostedCookie(HOSTED_SESSION_COOKIE_NAME, rawSessionId, {
        ...cookieOptions(),
        maxAgeSeconds: Math.max(
          1,
          Math.floor(config.HOSTED_SESSION_MAX_AGE_MS / 1000),
        ),
      }),
    );
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {string} location
   * @returns {void}
   */
  function seeOther(ctx, location) {
    ctx.response.writeHead(303, { Location: location });
    ctx.response.end();
  }

  // --- registration -------------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveRegister(ctx) {
    if (ctx.request.method === "POST") return handleRegisterSubmission(ctx);
    if (ctx.request.method === "GET") {
      renderRegisterForm(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string, emailValue?: string, successEmail?: string}} state
   * @returns {void}
   */
  function renderRegisterForm(ctx, statusCode, state) {
    const csrfToken = ensureCsrfToken(ctx);
    templates.register.serveWithStatus(ctx.request, ctx.response, statusCode, {
      // Conditional template sections must receive undefined rather than an
      // empty string: Handlebars renders sections for empty strings.
      hostedRegisterError: state.errorKey
        ? translate(templates.register, ctx, state.errorKey)
        : undefined,
      hostedRegisterEmailValue: state.emailValue || "",
      hostedRegisterSuccessEmail: state.successEmail
        ? translate(templates.register, ctx, "hosted_register_success_body", {
            email: state.successEmail,
          })
        : undefined,
      hostedRegisterLoginLink: translate(
        templates.register,
        ctx,
        "hosted_login_link",
      ),
      hostedCaptchaRequired: captcha.required,
      hostedCaptchaSiteKey: captcha.siteKey,
      hostedCaptchaFieldName: captcha.fieldName,
      csrfToken,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  /**
   * Shared admission gate for registration and login submissions: reads the
   * form body, enforces CSRF, applies the per-IP/per-email attempt limits,
   * and verifies the CAPTCHA contract. Returns the admission result; the
   * caller renders its own failure state through renderSubmissionFailure.
   *
   * @param {HttpRouteContext} ctx
   * @param {"register" | "login"} kind
   * @returns {Promise<{form: URLSearchParams, address: string, email: string} | null>}
   */
  async function admitSubmission(ctx, kind) {
    const form = await readFormBody(ctx.request);
    if (!hasValidCsrf(form, parseCookieHeader(ctx.request.headers.cookie))) {
      renderSubmissionFailure(ctx, kind, 403, "hosted_error_csrf", {});
      return null;
    }

    const address = clientIp(ctx);
    const email = normalizeEmail(form.get("email"));
    if (!consumeAttemptLimits(kind, address, email || "unparsable-email")) {
      renderSubmissionFailure(ctx, kind, 429, "hosted_error_rate_limited", {});
      return null;
    }

    const captchaVerification = await captcha.verify(
      form.get(captcha.fieldName),
      address,
      firstHeaderValue(ctx.request.headers.host),
    );
    if (captchaVerification.ok === false) {
      renderSubmissionFailure(ctx, kind, 403, "hosted_error_captcha", {});
      return null;
    }
    return { form, address, email };
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {"register" | "login"} kind
   * @param {number} statusCode
   * @param {string} errorKey
   * @param {{emailValue?: string}} state
   * @returns {void}
   */
  function renderSubmissionFailure(ctx, kind, statusCode, errorKey, state) {
    if (kind === "register") {
      renderRegisterForm(ctx, statusCode, {
        errorKey,
        emailValue: state.emailValue,
      });
      return;
    }
    renderLoginForm(ctx, statusCode, {
      errorKey,
      emailValue: state.emailValue,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleRegisterSubmission(ctx) {
    const admission = await admitSubmission(ctx, "register");
    if (!admission) return;
    const { form, email } = admission;

    const password = form.get("password");
    if (!isValidNormalizedEmail(email)) {
      renderRegisterForm(ctx, 400, {
        errorKey: "hosted_register_error_email",
        emailValue: safeEmailEcho(form.get("email")),
      });
      return;
    }
    if (
      typeof password !== "string" ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      renderRegisterForm(ctx, 400, {
        errorKey: "hosted_register_error_password",
        emailValue: email,
      });
      return;
    }
    if (form.get("ageConfirmation") !== "1") {
      renderRegisterForm(ctx, 400, {
        errorKey: "hosted_register_error_age",
        emailValue: email,
      });
      return;
    }

    const existingAccount = store.getAccountByEmail(email);
    if (existingAccount && existingAccount.verifiedAtMs !== null) {
      renderRegisterForm(ctx, 409, {
        errorKey: "hosted_register_error_email_taken",
        emailValue: email,
      });
      return;
    }

    let account;
    if (existingAccount) {
      // A still-unverified registration is repeated: adopt the latest
      // password and send a fresh single-use link.
      account = existingAccount;
      await store.updateAccountPassword(
        account.accountId,
        await hashPassword(password),
      );
    } else {
      account = await store.createAccount({
        email,
        passwordHash: await hashPassword(password),
      });
    }
    const rawToken = await store.createVerificationToken(account.accountId);
    await mail.send({
      to: email,
      subject: translate(
        templates.register,
        ctx,
        "hosted_mail_verification_subject",
      ),
      body: translate(
        templates.register,
        ctx,
        "hosted_mail_verification_body",
        { url: buildVerificationUrl(ctx, rawToken) },
      ),
    });
    logger.info("hosted.account_registered", {
      account_id: account.accountId,
      resent: Boolean(existingAccount),
    });
    renderRegisterForm(ctx, 200, { successEmail: email });
  }

  // --- email verification -------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveVerify(ctx) {
    if (ctx.request.method !== "GET") {
      throw new BoundaryError(405, "method_not_allowed");
    }
    return handleVerification(ctx);
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleVerification(ctx) {
    const rawToken = ctx.url.searchParams.get("token") || "";
    const accountId = await store.consumeVerificationToken(rawToken);
    const account = accountId ? store.getAccountById(accountId) : null;
    if (!accountId || !account) {
      // Invalid, already used, and expired tokens are rejected identically.
      templates.verify.serveWithStatus(ctx.request, ctx.response, 403, {
        hostedVerifyInvalid: translate(
          templates.verify,
          ctx,
          "hosted_verify_invalid",
        ),
      });
      return;
    }
    await store.markAccountVerified(accountId, clock());
    logger.info("hosted.account_verified", { account_id: accountId });
    seeOther(ctx, `${publicPath(config, "/login")}?verified=1`);
  }

  // --- login --------------------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveLogin(ctx) {
    if (ctx.request.method === "POST") return handleLoginSubmission(ctx);
    if (ctx.request.method === "GET") {
      renderLoginForm(ctx, 200, {});
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @param {number} statusCode
   * @param {{errorKey?: string, emailValue?: string}} state
   * @returns {void}
   */
  function renderLoginForm(ctx, statusCode, state) {
    const signedIn = resolveSignedInAccountFromRequest(store, ctx.request);
    const csrfToken = ensureCsrfToken(ctx);
    templates.login.serveWithStatus(ctx.request, ctx.response, statusCode, {
      hostedLoginError: state.errorKey
        ? translate(templates.login, ctx, state.errorKey)
        : undefined,
      hostedLoginEmailValue: state.emailValue || "",
      hostedLoginVerifiedNotice:
        ctx.url.searchParams.get("verified") === "1"
          ? translate(templates.login, ctx, "hosted_login_verified_notice")
          : undefined,
      hostedLoginSignedInEmail: signedIn ? signedIn.email : undefined,
      hostedLoginSignedInAs: signedIn
        ? translate(templates.login, ctx, "hosted_login_signed_in_as", {
            email: signedIn.email,
          })
        : undefined,
      hostedCaptchaRequired: captcha.required,
      hostedCaptchaSiteKey: captcha.siteKey,
      hostedCaptchaFieldName: captcha.fieldName,
      csrfToken,
    });
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleLoginSubmission(ctx) {
    const admission = await admitSubmission(ctx, "login");
    if (!admission) return;
    const { form, address, email } = admission;

    // Unknown emails, wrong passwords, unverified accounts, and disabled
    // accounts all cost the same and produce the same generic failure, so no
    // failure reveals whether an email is registered.
    const account = store.getAccountByEmail(email);
    const password = form.get("password");
    const passwordMatches =
      account !== null && typeof password === "string"
        ? await verifyPassword(password, account.passwordHash)
        : await verifyDummyPassword(
            typeof password === "string" ? password : "",
          );
    const authorized =
      passwordMatches &&
      account !== null &&
      typeof password === "string" &&
      account.verifiedAtMs !== null &&
      account.status === "active";
    if (!authorized) {
      logger.info("hosted.account_login_rejected", {
        "client.address": address,
      });
      renderLoginForm(ctx, 401, {
        errorKey: "hosted_login_invalid",
        emailValue: email,
      });
      return;
    }

    const rawSessionId = await store.createSession(account.accountId);
    issueSessionCookie(ctx, rawSessionId);
    logger.info("hosted.account_login", { account_id: account.accountId });
    seeOther(ctx, publicPath(config, "/"));
  }

  // --- logout -------------------------------------------------------------

  /**
   * @param {HttpRouteContext} ctx
   * @returns {void | Promise<void>}
   */
  function serveLogout(ctx) {
    if (ctx.request.method === "POST") return handleLogoutSubmission(ctx);
    if (ctx.request.method === "GET") {
      if (!resolveSignedInAccountFromRequest(store, ctx.request)) {
        seeOther(ctx, publicPath(config, "/"));
        return;
      }
      templates.logout.serveWithStatus(ctx.request, ctx.response, 200, {
        csrfToken: ensureCsrfToken(ctx),
      });
      return;
    }
    throw new BoundaryError(405, "method_not_allowed");
  }

  /**
   * @param {HttpRouteContext} ctx
   * @returns {Promise<void>}
   */
  async function handleLogoutSubmission(ctx) {
    const form = await readFormBody(ctx.request);
    if (!hasValidCsrf(form, parseCookieHeader(ctx.request.headers.cookie))) {
      templates.logout.serveWithStatus(ctx.request, ctx.response, 403, {
        hostedLogoutError: translate(
          templates.logout,
          ctx,
          "hosted_error_csrf",
        ),
        csrfToken: ensureCsrfToken(ctx),
      });
      return;
    }
    const signedIn = resolveSignedInAccountFromRequest(store, ctx.request);
    const rawSessionId = readHostedCookie(
      ctx.request.headers.cookie,
      HOSTED_SESSION_COOKIE_NAME,
    );
    if (rawSessionId) await store.revokeSession(rawSessionId);
    appendSetCookieHeader(
      ctx.response,
      clearHostedCookie(HOSTED_SESSION_COOKIE_NAME, cookieOptions()),
    );
    if (signedIn) {
      logger.info("hosted.account_logout", { account_id: signedIn.accountId });
    }
    seeOther(ctx, publicPath(config, "/"));
  }

  return { serveRegister, serveLogin, serveVerify, serveLogout };
}

/**
 * Synchronous signed-in account resolution for page rendering. Sessions are
 * validated against absolute and idle expiry; disabled or unverified
 * accounts never count as signed in.
 *
 * @param {ReturnType<typeof import("./store.mjs").createFileAccountStore>} store
 * @param {import("http").IncomingMessage} request
 * @returns {{accountId: string, email: string} | null}
 */
function resolveSignedInAccountFromRequest(store, request) {
  const rawSessionId = readHostedCookie(
    request.headers.cookie,
    HOSTED_SESSION_COOKIE_NAME,
  );
  if (!rawSessionId) return null;
  const session = store.peekSession(rawSessionId);
  if (!session) return null;
  const account = store.getAccountById(session.accountId);
  if (
    !account ||
    account.status !== "active" ||
    account.verifiedAtMs === null
  ) {
    return null;
  }
  return { accountId: account.accountId, email: account.email };
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Echoes a submitted, non-normalizable email back into the form with basic
 * hygiene; final rendering is always Handlebars-escaped.
 *
 * @param {string | null} value
 * @returns {string}
 */
function safeEmailEcho(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 254 ? "" : trimmed;
}

export { createHostedAccountRoutes, resolveSignedInAccountFromRequest };
