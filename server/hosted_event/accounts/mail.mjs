import * as fs from "node:fs/promises";
import * as path from "node:path";
import crypto from "node:crypto";

import { isValidNormalizedEmail, normalizeEmail } from "./emails.mjs";

/** @import { ServerConfig } from "../../../types/server-runtime.d.ts" */

/**
 * Durable outbox mail delivery.
 *
 * Lifecycle notices such as account verification are written as JSON files
 * into a configured outbox directory. The mail vendor for the first release
 * is not selected yet, so this adapter is the production delivery path: an
 * external sender drains the directory. Messages carry no credentials beyond
 * the single-use link the recipient needs.
 *
 * @param {ServerConfig} config
 * @returns {{send: (message: {to: string, subject: string, body: string}) => Promise<void>}}
 */
function createOutboxMailDelivery(config) {
  const outboxDir =
    config.HOSTED_MAIL_OUTBOX_DIR ||
    path.join(config.HOSTED_DATA_DIR, "mail-outbox");

  /**
   * @param {{to: string, subject: string, body: string}} message
   * @returns {Promise<void>}
   */
  async function send(message) {
    const to = normalizeEmail(message.to);
    if (!isValidNormalizedEmail(to)) {
      throw new Error("outbox mail delivery requires a valid recipient");
    }
    const subject = String(message.subject || "");
    const body = String(message.body || "");
    if (subject === "" || body === "") {
      throw new Error("outbox mail delivery requires a subject and body");
    }
    await fs.mkdir(outboxDir, { recursive: true });
    const fileName = `message-${Date.now()}-${crypto
      .randomBytes(6)
      .toString("hex")}.json`;
    await fs.writeFile(
      path.join(outboxDir, fileName),
      JSON.stringify(
        {
          to,
          subject,
          body,
          sentAtMs: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return { send };
}

export { createOutboxMailDelivery };
