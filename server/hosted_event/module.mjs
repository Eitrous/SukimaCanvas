import { localizedHref, Template } from "../http/templating.mjs";

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
   * @param {{htmlHeadSnippet?: string}} [options]
   */
  constructor(templatePath, serverConfig, options) {
    super(templatePath, serverConfig, {
      ...options,
      supportedLanguages: HOSTED_LANGUAGES,
      languageMatching: "strict",
    });
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
    return params;
  }

  /**
   * @param {HttpRequest} request
   * @param {HttpResponse} response
   * @param {number} statusCode
   * @param {object} [extraParams]
   * @returns {{encoding: import("../http/compression.mjs").CompressionEncoding | undefined}}
   */
  serveWithStatus(request, response, statusCode, extraParams) {
    return this.serveStatus(request, response, statusCode, false, extraParams);
  }
}

/**
 * @param {ServerConfig} config
 * @param {{homeTemplatePath: string, sourceTemplatePath: string, htmlHeadSnippet?: string}} paths
 * @returns {import("../../types/server-runtime.d.ts").HostedEventModule}
 */
function createHostedEventModule(config, paths) {
  const homeTemplate = new HostedPageTemplate(paths.homeTemplatePath, config, {
    htmlHeadSnippet: paths.htmlHeadSnippet,
  });
  const sourceTemplate = new HostedPageTemplate(
    paths.sourceTemplatePath,
    config,
    { htmlHeadSnippet: paths.htmlHeadSnippet },
  );
  const sourceMapping = resolveSourceMapping(config);

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
