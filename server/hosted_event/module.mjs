import { localizedHref, Template } from "../http/templating.mjs";
import { createHostedCaptcha } from "./accounts/captcha.mjs";
import { createOutboxMailDelivery } from "./accounts/mail.mjs";
import { createRateLimiter } from "./accounts/rate_limits.mjs";
import {
  createHostedAccountRoutes,
  resolveSignedInAccountFromRequest,
} from "./accounts/routes.mjs";
import { createFileAccountStore } from "./accounts/store.mjs";

/** @import { HttpRequest, HttpResponse, ServerConfig } from "../../types/server-runtime.d.ts" */

const HOSTED_LANGUAGES = ["en", "zh-CN"];
const ROLLING_VERSION_LABELS = new Set([
  "current",
  "default",
  "develop",
  "development",
  "dev",
  "head",
  "latest",
  "main",
  "master",
  "release",
  "stable",
  "trunk",
]);

class HostedPageTemplate extends Template {
  /**
   * @param {string} templatePath
   * @param {ServerConfig} serverConfig
   * @param {{htmlHeadSnippet?: string, resolveAccount?: (request: HttpRequest) => {accountId: string, email: string} | null}} [options]
   */
  constructor(templatePath, serverConfig, options) {
    super(templatePath, serverConfig, {
      ...options,
      supportedLanguages: HOSTED_LANGUAGES,
      languageMatching: "strict",
    });
    this.resolveAccount = options?.resolveAccount;
  }

  /**
   * @param {URL} parsedUrl
   * @param {HttpRequest} request
   * @param {boolean} isModerator
   * @param {{sourceAvailable?: boolean, sourceUrl?: string, deploymentVersion?: string, sourceBuildInstructions?: string}} [extraParams]
   * @returns {import("../http/templating.mjs").TemplateParameters}
   */
  parameters(parsedUrl, request, isModerator, extraParams = {}) {
    const params = super.parameters(
      parsedUrl,
      request,
      isModerator,
      extraParams,
    );
    const pagePath = parsedUrl.pathname === "/source" ? "source" : ".";
    const pageUrl = new URL(pagePath, params.baseHref).href;
    params.hostedLanguage = params.language;
    params.hostedDirection = params.direction;
    params.hostedTranslations = params.translations;
    params.hostedLanguageLinks = params.languages.map((language) => ({
      language,
      href: localizedHref(pageUrl, language),
    }));
    params.hostedCanonicalUrl = localizedHref(pageUrl, params.language);
    // Hosted pages render account state, so they must never be cached by
    // shared caches or stored by browsers.
    params.varyCookie = true;
    const account = this.resolveAccount ? this.resolveAccount(request) : null;
    params.hostedAccount = account ? { email: account.email } : null;
    return params;
  }

  /**
   * @returns {string}
   */
  cacheControl() {
    return "no-store";
  }

  /**
   * @param {HttpRequest} request
   * @param {HttpResponse} response
   * @param {number} statusCode
   * @param {object} [extraParams]
   * @returns {{encoding: import("../http/compression.mjs").CompressionEncoding | undefined}}
   */
  serveWithStatus(request, response, statusCode, extraParams) {
    // Verification links carry single-use tokens in the URL; hosted pages
    // must never propagate their URLs onward through Referer.
    response.setHeader("Referrer-Policy", "no-referrer");
    return this.serveStatus(request, response, statusCode, false, extraParams);
  }
}

/**
 * @param {ServerConfig} config
 * @param {{
 *   homeTemplatePath: string,
 *   sourceTemplatePath: string,
 *   registerTemplatePath: string,
 *   loginTemplatePath: string,
 *   verifyTemplatePath: string,
 *   logoutTemplatePath: string,
 *   forgotTemplatePath: string,
 *   resetTemplatePath: string,
 *   accountTemplatePath: string,
 *   htmlHeadSnippet?: string,
 * }} paths
 * @returns {import("../../types/server-runtime.d.ts").HostedEventModule}
 */
function createHostedEventModule(config, paths) {
  // The clock is an injectable adapter: deployments use the Date.now
  // default, isolated tests override it through the composed config object
  // so expiry and revocation are exercised against server-authoritative
  // time without sleeps.
  const clock =
    typeof config.HOSTED_CLOCK === "function" ? config.HOSTED_CLOCK : undefined;
  const store = createFileAccountStore({
    dataDir: config.HOSTED_DATA_DIR,
    clock,
    sessionMaxAgeMs: config.HOSTED_SESSION_MAX_AGE_MS,
    sessionIdleMs: config.HOSTED_SESSION_IDLE_TIMEOUT_MS,
    verificationTokenTtlMs: config.HOSTED_VERIFICATION_TOKEN_TTL_MS,
    passwordResetTtlMs: config.HOSTED_PASSWORD_RESET_TTL_MS,
  });
  // Every hosted page renders the session-aware header, including home and
  // source, so all hosted templates share the account resolver.
  /** @type {(request: HttpRequest) => {accountId: string, email: string} | null} */
  const resolveAccount = (request) =>
    resolveSignedInAccountFromRequest(store, request);
  const templateOptions = {
    htmlHeadSnippet: paths.htmlHeadSnippet,
    resolveAccount,
  };
  const homeTemplate = new HostedPageTemplate(
    paths.homeTemplatePath,
    config,
    templateOptions,
  );
  const sourceTemplate = new HostedPageTemplate(
    paths.sourceTemplatePath,
    config,
    templateOptions,
  );
  const sourceMapping = resolveSourceMapping(config);

  const accountRoutes = createHostedAccountRoutes({
    config,
    clock,
    store,
    mail: createOutboxMailDelivery(config),
    captcha: createHostedCaptcha(config),
    limiter: createRateLimiter({ clock }),
    templates: {
      register: new HostedPageTemplate(
        paths.registerTemplatePath,
        config,
        templateOptions,
      ),
      login: new HostedPageTemplate(
        paths.loginTemplatePath,
        config,
        templateOptions,
      ),
      verify: new HostedPageTemplate(
        paths.verifyTemplatePath,
        config,
        templateOptions,
      ),
      logout: new HostedPageTemplate(
        paths.logoutTemplatePath,
        config,
        templateOptions,
      ),
      forgot: new HostedPageTemplate(
        paths.forgotTemplatePath,
        config,
        templateOptions,
      ),
      reset: new HostedPageTemplate(
        paths.resetTemplatePath,
        config,
        templateOptions,
      ),
      account: new HostedPageTemplate(
        paths.accountTemplatePath,
        config,
        templateOptions,
      ),
    },
  });

  return {
    enabled: config.HOSTED_MODE === true,
    serveHome(ctx) {
      homeTemplate.serveWithStatus(ctx.request, ctx.response, 200);
    },
    serveSource(ctx) {
      const statusCode = sourceMapping.available ? 200 : 503;
      sourceTemplate.serveWithStatus(ctx.request, ctx.response, statusCode, {
        sourceAvailable: sourceMapping.available,
        ...(sourceMapping.available
          ? {
              sourceUrl: sourceMapping.url,
              deploymentVersion: sourceMapping.version,
              sourceBuildInstructions: sourceMapping.buildInstructions,
            }
          : {}),
      });
    },
    ...accountRoutes,
  };
}

/**
 * @param {ServerConfig} config
 * @returns {{available: true, url: string, version: string, buildInstructions: string} | {available: false}}
 */
function resolveSourceMapping(config) {
  const version =
    typeof config.DEPLOYMENT_VERSION === "string"
      ? config.DEPLOYMENT_VERSION.trim()
      : "";
  const sourceUrl =
    typeof config.CORRESPONDING_SOURCE_URL === "string"
      ? config.CORRESPONDING_SOURCE_URL.trim()
      : "";
  const buildInstructions =
    typeof config.CORRESPONDING_SOURCE_BUILD === "string"
      ? config.CORRESPONDING_SOURCE_BUILD.trim()
      : "";
  if (!version || !sourceUrl || !buildInstructions) {
    return { available: false };
  }
  if (ROLLING_VERSION_LABELS.has(version.toLowerCase())) {
    return { available: false };
  }
  if (!sourceUrl.includes("{version}")) return { available: false };

  try {
    const renderedSourceUrl = sourceUrl
      .split("{version}")
      .join(encodeURIComponent(version));
    const parsed = new URL(renderedSourceUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { available: false };
    }
    if (parsed.username || parsed.password) return { available: false };
    return { available: true, url: parsed.href, version, buildInstructions };
  } catch {
    return { available: false };
  }
}

export { createHostedEventModule };
