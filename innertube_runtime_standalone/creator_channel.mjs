import { createHash } from "node:crypto";
import { Constants } from "youtubei.js";

const studioOrigin = "https://studio.youtube.com";
const studioBase = `${studioOrigin}/youtubei/v1`;
const endpoint = "/creator/update_creator_channel";

/** @param {unknown} value */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Send an arbitrary creator/update_creator_channel request body. Keep settings
 * and channelReadMask opaque; this API does not interpret individual settings.
 *
 * @param {import("youtubei.js").Innertube} youtube
 * @param {Record<string, any>} body
 */
export async function updateCreatorChannel(youtube, body) {
  if (!object(body) || typeof body.channelId !== "string" || !body.channelId.trim()) {
    throw new TypeError("update_creator_channel requires an owner channelId");
  }
  if (body.context !== undefined && !object(body.context)) {
    throw new TypeError("context must be an object");
  }
  const session = youtube.session;
  const supplied = body.context || {};
  const context = {
    ...session.context,
    ...supplied,
    client: {
      ...session.context.client,
      clientVersion: Constants.CLIENTS.WEB_CREATOR.VERSION,
      ...supplied.client,
      clientName: 62,
    },
    user: { ...session.context.user, ...supplied.user },
  };
  // Selection belongs to the authenticated session, not a caller's body.
  const pageId = session.context.user.onBehalfOfUser;
  if (pageId) context.user.onBehalfOfUser = pageId;
  else delete context.user.onBehalfOfUser;
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Goog-Authuser": String(session.account_index),
  });
  if (pageId) headers.set("X-Goog-PageId", pageId);
  // A custom base keeps HTTPClient from replacing context. Its skipped auth
  // and overwritten client headers are supplied by studioFetchInit below at
  // the existing cookie-synced fetch boundary, using the current cookie jar.
  const response = await session.http.fetch(endpoint, {
    baseURL: studioBase,
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, context }),
    redirect: "error",
  });
  return response.json();
}

/**
 * Adapt only this Studio endpoint inside the worker's existing youtubeFetch.
 * No separate fetch function or credential store is introduced.
 *
 * @param {Request | URL | string} input
 * @param {RequestInit} init
 * @param {string} cookie Current serialized cookie jar.
 * @returns {RequestInit}
 */
export function studioFetchInit(input, init, cookie) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== studioOrigin || url.pathname !== `/youtubei/v1${endpoint}`) return init;
  if (typeof init.body !== "string") throw new TypeError("Studio body must be JSON");
  const body = JSON.parse(init.body);
  const sapisid = cookie.split(/;\s*/).find((part) => part.startsWith("SAPISID="))?.slice(8);
  if (!sapisid) throw new Error("Studio channel updates require a SAPISID cookie");
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = createHash("sha1").update(`${timestamp} ${sapisid} ${studioOrigin}`).digest("hex");
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  headers.set("Authorization", `SAPISIDHASH ${timestamp}_${hash}`);
  headers.set("Origin", studioOrigin);
  headers.set("X-Origin", studioOrigin);
  headers.set("X-Youtube-Client-Name", "62");
  headers.set("X-Youtube-Client-Version", body.context.client.clientVersion);
  return { ...init, headers, redirect: "error" };
}
