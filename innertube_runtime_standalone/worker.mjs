import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Context } from "cordis";
import { CordisBridge, lineTransport } from "./cordis_bridge.mjs";
import { httpStatus, isTransientNetworkError } from "./network_errors.mjs";
import { ChatItems, responseActions } from "./chat_items.mjs";
import { deletionTimestamp } from "./chat_deletions.mjs";
import { studioFetchInit, updateCreatorChannel } from "./creator_channel.mjs";

/** @typedef {import("youtubei.js").Innertube} YouTubeClient */
/** @typedef {Record<string, any>} DynamicObject */
/** @typedef {{ field: number, wire: number, value: bigint | Buffer, children?: ProtoNode[] }} ProtoNode */
/** @typedef {{ params: string, label: string, icon: string, known_seconds?: number }} ModerationCandidate */
/** @typedef {{ renderer: DynamicObject, label: string, icon: string }} MenuRenderer */
/** @typedef {{ live_chat: any, video_id: string, owner_channel_id: string, last_error: unknown, retry_attempts: number, handle_action?: (action: any) => void, resolve_review?: (messageId: string, reviewState: 'shown' | 'hidden') => void }} SubscriptionState */
/** @typedef {{ owner_channel_id: string, info?: any }} VideoContext */
/** @typedef {{ channel_id: string, is_moderator: boolean, present_at_ms?: number }} ModerationPresence */

const protocolOutput = process.stdout;
const secretsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "secrets");
const cookieFilePath = () => path.resolve(process.env.YT_STREAM_MODBOT_COOKIE_FILE || path.join(secretsDir, "youtube_cookie.txt"));
const chromeProfilePath = () => path.resolve(process.env.YT_STREAM_MODBOT_CHROME_PROFILE_DIR || path.join(secretsDir, "innertube_chrome_profile"));
/** @type {CordisBridge | null} */
let workerBridge = null;

/** @param {...unknown} values */
function stderr(...values) {
  process.stderr.write(`${values.map(formatValue).join(" ")}\n`);
}

/** @param {unknown} value */
function formatValue(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// youtubei.js has its own logger. stdout belongs exclusively to the JSONL
// protocol, so redirect every console method before loading the package.
console.log = stderr;
console.info = stderr;
console.debug = stderr;
console.warn = stderr;
console.error = stderr;

const { Helpers, Innertube, Log, Misc, Parser, YTNodes } = await import("youtubei.js");

Log.setLevel(Log.Level.NONE);

const parserWarnings = new Set();
Parser.setParserErrorHandler(
  (/** @type {any} */ context) => {
    const kind = String(context?.error_type || "unknown");
    const name = String(context?.classname || "unknown node");
    const key = `${kind}:${name}`;
    if (parserWarnings.has(key)) return;
    parserWarnings.add(key);
    stderr(`youtubei parser ${kind}: ${name} (continuing)`);
  },
);

class WorkerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {boolean} [retryable]
   * @param {number} [status]
   */
  constructor(code, message, retryable = false, status = undefined) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** @type {YouTubeClient | undefined} */
let youtube;
let cookie = "";
let cookieFileValue = "";
/** @type {{ account_index: number, on_behalf_of_user?: string } | undefined} */
let accountContext;
/** @type {Map<string, string>} */
const cookieJar = new Map();
let cookieWrite = Promise.resolve();
/** @type {"unknown" | "valid" | "expired"} */
let authenticationState = "unknown";
/** @type {string | null} */
let authenticatedChannelId = null;
/** @type {string | null} */
let authenticatedChannelHandle = null;
/** @type {string | null} */
let authenticatedChannelName = null;
/** @type {string | null} */
let authenticatedChannelAvatarUrl = null;
let identityRetryAt = 0;
/** @type {string | undefined} */
let resolvedTarget;
/** @type {string | undefined} */
let resolvedChannelId;
/** @type {Map<string, VideoContext>} */
const videoContexts = new Map();
/** @type {Map<string, SubscriptionState>} */
const subscriptions = new Map();
/** @type {Map<string, { endpoint: any, video_id: string }>} */
const messageMenus = new Map();
/** @type {Map<string, { show?: any, hide?: any }>} */
const heldReviewActions = new Map();
/** Per-video viewing context and the authenticated viewer's moderation state. */
/** @type {Map<string, ModerationPresence>} */
const moderationPresence = new Map();
const MAX_MESSAGE_MENUS = 50_000;

/** @param {string} videoId */
function getModerationPresence(videoId) {
  return moderationPresence.get(videoId);
}

/** @param {string} videoId @param {ModerationPresence} presence */
function setModerationPresence(videoId, presence) {
  const previous = moderationPresence.get(videoId);
  moderationPresence.set(videoId, presence);
  return previous;
}

// youtubei.js captures its cookie argument in a private field. A proxy keeps
// that field string-like while resolving every operation against the current
// cookie jar, including SAPISID lookup and Cookie header serialization.
const cookieProxy = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => cookie;
      const value = Reflect.get(Object(cookie), property);
      return typeof value === "function" ? value.bind(cookie) : value;
    },
  },
);

class ImmediateActionQueue {
  /** @type {((actions: any[]) => void | Promise<void>) | null} */
  callback;
  active = true;

  /**
   * @param {((actions: any[]) => void | Promise<void>) | null} callback
   * @param {() => void} onPoll
   */
  constructor(callback, onPoll) {
    this.callback = callback;
    this.onPoll = onPoll;
  }

  /** @param {any[]} actions */
  enqueueActionGroup(actions) {
    if (!this.active || !this.callback) return;
    this.onPoll();
    Promise.resolve(this.callback(actions)).catch((error) => {
      stderr("live chat action processing failed:", error);
    });
  }

  clear() {
    this.active = false;
  }
}

/**
 * @param {Map<string, any>} items
 * @param {string} key
 * @param {any} value
 */
function retainRecent(items, key, value) {
  items.delete(key);
  items.set(key, value);
  if (items.size <= MAX_MESSAGE_MENUS) return;
  const oldest = items.keys().next().value;
  if (oldest !== undefined) items.delete(oldest);
}

/** @param {any} value */
function rawText(value) {
  if (typeof value?.simpleText === "string") return value.simpleText;
  if (!Array.isArray(value?.runs)) return "";
  return value.runs
    .map(
      (/** @type {any} */ run) =>
        run?.emoji?.shortcuts?.[0] || run?.text || "",
    )
    .join("");
}

/** @param {any} thumbnails */
function imageUrl(thumbnails) {
  if (!Array.isArray(thumbnails)) return "";
  const url = thumbnails.at(-1)?.url || thumbnails[0]?.url;
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : "";
}

/** Normalize every authored/displayable live-chat renderer into one message.
 * `text` is exclusively arbitrary user-authored text. YouTube-generated copy
 * stays in `event_text` and never enters moderation.
 * @param {any} item @param {string} ownerChannelId */
function normalizedChatItem(item, ownerChannelId) {
  if (!item?.id) return null;
  const type = String(item.type || "");
  let author = item.author;
  if (!author && item.author_external_channel_id) {
    author = {
      id: item.author_external_channel_id,
      name: textValue(item.author_name),
      thumbnails: item.author_photo || [],
      is_moderator: item.author_badges?.some?.(
        (/** @type {any} */ badge) => badge.icon_type === "MODERATOR",
      ),
    };
  }
  let eventKind = "text";
  let text = "";
  let eventText = "";
  let purchaseAmount = "";
  let eventImageUrl = "";
  let eventImageAlt = "";
  let jewelsAmount;
  let moderatableText = false;
  let menuEndpoint = item.menu_endpoint;

  if (type === "LiveChatPaidMessage") {
    eventKind = "super_chat";
    text = textValue(item.message);
    purchaseAmount = textValue(item.purchase_amount);
    moderatableText = Boolean(text);
  } else if (type === "LiveChatPaidSticker") {
    eventKind = "super_sticker";
    eventText = textValue(item.sticker_accessibility_label) || "Super Sticker";
    purchaseAmount = textValue(item.purchase_amount);
    eventImageUrl = imageUrl(item.sticker);
    eventImageAlt = eventText;
  } else if (type === "LiveChatMembershipItem") {
    eventKind = "membership";
    text = textValue(item.message);
    eventText = [textValue(item.header_primary_text), textValue(item.header_subtext)].filter(Boolean).join(" · ");
    moderatableText = Boolean(text);
  } else if (type === "LiveChatSponsorshipsGiftPurchaseAnnouncement") {
    eventKind = "membership_gift";
    const header = item.header;
    author = {
      id: item.author_external_channel_id,
      name: textValue(header?.author_name),
      thumbnails: header?.author_photo || [],
      is_moderator: header?.author_badges?.some((/** @type {any} */ badge) => badge.icon_type === "MODERATOR"),
    };
    eventText = textValue(header?.primary_text) || "Gifted channel memberships";
    eventImageUrl = imageUrl(header?.image);
    eventImageAlt = eventText;
    menuEndpoint = header?.menu_endpoint;
  } else if (type === "LiveChatSponsorshipsGiftRedemptionAnnouncement") {
    eventKind = "membership_gift_received";
    eventText = textValue(item.message) || "Received a gift membership";
  } else if (item.gift_metadata || item.jewels_amount != null || /(?:jewel|livechatgift|virtual.*gift)/i.test(type)) {
    eventKind = "jewels_gift";
    const gift = item.gift_metadata || item.gift?.gift_metadata || item.gift || item;
    eventText = textValue(item.event_text || item.message || item.primary_text)
      || textValue(gift.giftName || gift.gift_name || gift.altText || gift.alt_text) || "Sent a gift";
    eventImageUrl = String(gift.giftUrl || gift.gift_url || imageUrl(gift.image || item.image) || "");
    eventImageAlt = textValue(gift.altText || gift.alt_text) || eventText;
    const amount = Number(gift.jewelsAmount ?? gift.jewels_amount ?? item.jewels_amount);
    jewelsAmount = Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
  } else if (item.message && author) {
    text = textValue(item.original_message || item.display_message || item.message);
    moderatableText = Boolean(text);
  } else {
    return null;
  }

  if (!author?.id) return null;
  const timestamp = Number(item.timestamp ?? Number(item.timestamp_usec) / 1000);
  return {
    id: String(item.id),
    author,
    text,
    event_kind: eventKind,
    event_text: eventText || null,
    purchase_amount: purchaseAmount || null,
    event_image_url: /^https:\/\//i.test(eventImageUrl) ? eventImageUrl : null,
    event_image_alt: eventImageAlt || null,
    jewels_amount: jewelsAmount ?? null,
    moderatable_text: moderatableText,
    menu_endpoint: menuEndpoint,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    is_owner: author.id === ownerChannelId,
  };
}

class LiveChatTextMessageWithOriginal extends YTNodes.LiveChatTextMessage {
  /** @type {string} */
  display_message;
  /** @type {string | undefined} */
  original_message;
  /** @type {import("youtubei.js").Misc.Text | undefined} */
  deleted_state_message;

  /** @param {any} data */
  constructor(data) {
    super(data);
    this.display_message = rawText(data.message);
    // YouTube's isDeleted is truthy(data.deletedStateMessage), not renderer type.
    if (data.deletedStateMessage) {
      this.deleted_state_message = new Misc.Text(data.deletedStateMessage);
    }
    if (data?.messagePrefixIcon?.iconType === "TRANSLATE") {
      this.original_message = rawText(data.hoverMessage) || undefined;
    }
  }
}

Parser.addRuntimeParser(
  LiveChatTextMessageWithOriginal.type,
  LiveChatTextMessageWithOriginal,
);

class LiveChatAutoModMessageWithAuthor extends YTNodes.LiveChatAutoModMessage {
  /** @param {any} data */
  constructor(data) {
    super(data);
    this.author_external_channel_id = data.authorExternalChannelId;
  }
}
Parser.addRuntimeParser(LiveChatAutoModMessageWithAuthor.type, LiveChatAutoModMessageWithAuthor);

// The upstream parsers drop optional action timestamps. Keep them for matching
// delayed deletion events to our recorded timeouts.
/** @type {import('youtubei.js').Helpers.YTNodeConstructor[]} */
const deletionParsers = [YTNodes.MarkChatItemAsDeletedAction, YTNodes.MarkChatItemsByAuthorAsDeletedAction, YTNodes.RemoveChatItemAction, YTNodes.RemoveChatItemByAuthorAction];
for (const Base of deletionParsers) {
  class TimedDeletion extends Base {
    static type = Base.type;
    /** @param {ConstructorParameters<typeof Base>[0]} data */
    constructor(data) {
      super(data);
      this.event_timestamp = deletionTimestamp(data);
    }
  }
  Parser.addRuntimeParser(Base.type, TimedDeletion);
}

class LiveChatModerationMessage extends Helpers.YTNode {
  static type = "LiveChatModerationMessage";
  /** @param {any} data */
  constructor(data) {
    super();
    this.id = String(data.id || "");
    this.text = rawText(data.message || data.text);
    const timestamp = Number(data.timestampUsec) / 1000;
    this.timestamp = Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp).toISOString() : new Date().toISOString();
  }
}
Parser.addRuntimeParser(LiveChatModerationMessage.type, LiveChatModerationMessage);

class LiveChatReportPresenceCommand extends Helpers.YTNode {
  static type = "LiveChatReportPresenceCommand";
  /** @type {string} */
  video_id;
  /** @type {string} */
  channel_id;
  /** @type {boolean} */
  is_moderator;
  /** @type {number | undefined} */
  present_at_ms;

  /** @param {any} data */
  constructor(data) {
    super();
    const present = data?.liveChatUserPresent;
    this.video_id = String(present?.externalVideoId || "");
    this.channel_id = String(present?.externalChannelId || "");
    this.is_moderator = Boolean(present?.isModerator);
    const timestamp = Number(data?.presentAtMs);
    this.present_at_ms = Number.isFinite(timestamp) ? timestamp : undefined;
  }
}

Parser.addRuntimeParser(
  LiveChatReportPresenceCommand.type,
  LiveChatReportPresenceCommand,
);

// YouTube emits this owner-only marker without state for us to consume. Parse
// it so youtubei.js does not report an unknown renderer, but do not confuse it
// with the authenticated viewer's moderator capability.
class LiveChatReportModerationStateCommand extends Helpers.YTNode {
  static type = "LiveChatReportModerationStateCommand";
}
Parser.addRuntimeParser(
  LiveChatReportModerationStateCommand.type,
  LiveChatReportModerationStateCommand,
);

/**
 * Keep the cookie jar current and persisted. Outbound cookies and SAPISID
 * authorization resolve through cookieProxy inside youtubei.js.
 *
 * @param {any} input
 * @param {any} init
 */
async function youtubeFetch(input, init) {
  const response = await fetch(input, studioFetchInit(input, init, cookie));
  await updateCookiesFromResponse(response);
  return response;
}

function serializeCookieJar() {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** @param {string} value */
function replaceCookieJar(value) {
  cookieJar.clear();
  for (const part of value.split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookieJar.set(part.slice(0, separator).trim(), part.slice(separator + 1));
  }
  cookie = serializeCookieJar();
}

/** @param {string} value */
function applySetCookie(value) {
  const parts = value.split(/;\s*/);
  const separator = parts[0]?.indexOf("=") ?? -1;
  if (separator <= 0) return false;
  const name = parts[0].slice(0, separator).trim();
  const newValue = parts[0].slice(separator + 1);
  const attributes = parts.slice(1).map((part) => part.toLowerCase());
  const expired = attributes.some(
    (attribute) =>
      attribute === "max-age=0" ||
      (attribute.startsWith("expires=") &&
        Date.parse(attribute.slice("expires=".length)) <= Date.now()),
  );
  if (expired) return cookieJar.delete(name);
  if (cookieJar.get(name) === newValue) return false;
  cookieJar.set(name, newValue);
  return true;
}

/** @param {Response} response */
async function updateCookiesFromResponse(response) {
  const values = response.headers.getSetCookie();
  let changed = false;
  for (const value of values) changed = applySetCookie(value) || changed;
  if (!changed) return;
  cookie = serializeCookieJar();
  await persistCookie();
}

/** @param {boolean} [required] */
async function persistCookie(required = false) {
  const cookieFile = cookieFilePath();
  // Store the selection and cookies atomically; refreshing cookies must not
  // forget which channel they are being used on behalf of.
  const snapshot = accountContext
    ? JSON.stringify({ cookie, ...accountContext }) : cookie;
  const value = `${snapshot}\n`;
  cookieWrite = cookieWrite.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(cookieFile), { recursive: true, mode: 0o700 });
    const temporaryPath = `${cookieFile}.tmp`;
    await fs.writeFile(temporaryPath, value, { mode: 0o600 });
    await fs.rename(temporaryPath, cookieFile);
    cookieFileValue = snapshot;
  });
  try {
    await cookieWrite;
  } catch (error) {
    if (required) throw error;
    stderr("could not persist refreshed YouTube cookies:", error);
  }
}

/** @param {string} value */
function loadAuthentication(value) {
  if (value.startsWith("{")) {
    const saved = JSON.parse(value);
    if (typeof saved.cookie !== "string" ||
        !Number.isSafeInteger(saved.account_index) || saved.account_index < 0 ||
        (saved.on_behalf_of_user !== undefined &&
          (typeof saved.on_behalf_of_user !== "string" || !saved.on_behalf_of_user))) {
      throw new WorkerError("INVALID_AUTH_FILE", "Invalid saved YouTube account context");
    }
    accountContext = {
      account_index: saved.account_index,
      ...(saved.on_behalf_of_user ? { on_behalf_of_user: saved.on_behalf_of_user } : {}),
    };
    replaceCookieJar(saved.cookie);
  } else {
    // Existing manually copied Cookie headers remain supported.
    accountContext = undefined;
    replaceCookieJar(value);
  }
}

function resetAuthentication() {
  youtube = undefined;
  moderationPresence.clear();
  videoContexts.clear();
  messageMenus.clear();
  heldReviewActions.clear();
  authenticationState = "unknown";
  authenticatedChannelId = null;
  authenticatedChannelHandle = null;
  identityRetryAt = 0;
  // LiveChat and cached video info retain the old client's account context.
  // End those readers so they reconnect with the newly selected account.
  for (const [subscriptionId, state] of subscriptions) {
    subscriptions.delete(subscriptionId);
    state.live_chat.stop();
    sendEvent("subscription_end", { subscription_id: subscriptionId, error: null });
  }
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {import("node:child_process").ChildProcess} child */
function childCompletion(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

class CdpConnection {
  /** @type {WebSocket} */
  socket;
  nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  pending = new Map();

  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP request failed"));
      } else {
        pending.resolve(message.result || {});
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  /** @param {string} url */
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to Chrome DevTools")),
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  /**
   * @param {string} method
   * @param {DynamicObject} [params]
   * @param {string} [sessionId]
   */
  request(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    this.socket.close();
  }
}

/**
 * @param {string} file
 * @param {number} deadline
 */
async function readDevToolsEndpoint(file, deadline) {
  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = (await fs.readFile(file, "utf8")).split(/\r?\n/);
      if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await sleep(200);
  }
  throw new WorkerError("CHROME_LOGIN_TIMEOUT", "Chrome did not start in time");
}

/** @param {any[]} cookies */
function replaceCookieJarFromChrome(cookies) {
  cookieJar.clear();
  const selected = cookies
    .filter(
      (item) =>
        typeof item?.name === "string" &&
        typeof item?.value === "string" &&
        (item.domain === "youtube.com" ||
          item.domain === ".youtube.com" ||
          item.domain?.endsWith(".youtube.com")),
    )
    .sort((left, right) => left.path.length - right.path.length);
  for (const item of selected) cookieJar.set(item.name, item.value);
  cookie = serializeCookieJar();
}

async function chromeCommand() {
  if (process.env.YT_STREAM_MODBOT_CHROME_COMMAND) return process.env.YT_STREAM_MODBOT_CHROME_COMMAND;
  /** @param {string} command */
  const exists = (command) => fs.stat(command).then(info => info.isFile()).catch(() => false);
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
    for (const root of roots) {
      if (!root) continue;
      const command = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
      if (await exists(command)) return command;
    }
  } else if (process.platform === "darwin") {
    for (const applications of ["/Applications", path.join(os.homedir(), "Applications")]) {
      const command = path.join(applications, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
      if (await exists(command)) return command;
    }
  } else {
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (!directory) continue;
      for (const name of ["google-chrome", "google-chrome-stable"]) {
        const command = path.join(directory, name);
        if (await exists(command)) return command;
      }
    }
  }
  throw new WorkerError("CHROME_LOGIN_CONFIG", "Google Chrome was not found; set YT_STREAM_MODBOT_CHROME_COMMAND to the Chrome executable");
}

async function chromeLogin() {
  const command = await chromeCommand();
  const profileDir = chromeProfilePath();
  const timeoutSeconds = Number(
    process.env.YT_STREAM_MODBOT_CHROME_LOGIN_TIMEOUT_SECONDS || "300",
  );
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const endpointFile = path.join(profileDir, "DevToolsActivePort");
  await fs.rm(endpointFile, { force: true });
  stderr(
    "Sign into YouTube in the dedicated Chrome window, then close that window",
  );
  const loginChrome = spawn(
    command,
    [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://www.youtube.com/",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let loginTimer;
  const loginClosed = await Promise.race([
    childCompletion(loginChrome).then(() => true),
    new Promise((resolve) => { loginTimer = setTimeout(() => resolve(false), timeoutSeconds * 1000); }),
  ]).finally(() => clearTimeout(loginTimer));
  if (!loginClosed) {
    loginChrome.kill("SIGTERM");
    throw new WorkerError(
      "CHROME_LOGIN_TIMEOUT",
      `Dedicated Chrome was not closed within ${timeoutSeconds} seconds`,
    );
  }

  await fs.rm(endpointFile, { force: true });
  const extractionChrome = spawn(
    command,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const extractionExit = childCompletion(extractionChrome);
  /** @type {CdpConnection | undefined} */
  let cdp;
  try {
    const endpoint = await Promise.race([
      readDevToolsEndpoint(endpointFile, deadline),
      extractionExit.then(() => {
        throw new WorkerError(
          "CHROME_LOGIN_FAILED",
          "Chrome exited before cookie extraction started",
        );
      }),
    ]);
    cdp = await CdpConnection.connect(endpoint);
    const selectedAccount = await readChromeAccount(cdp);
    const result = await cdp.request("Storage.getCookies");
    replaceCookieJarFromChrome(result.cookies || []);
    if (!cookieJar.has("SAPISID") || !cookieJar.has("LOGIN_INFO")) {
      throw new WorkerError(
        "CHROME_LOGIN_FAILED",
        "Chrome reported a login but did not expose the required YouTube cookies",
      );
    }
    accountContext = selectedAccount;
    await persistCookie(true);
    await cdp.request("Browser.close");
    await Promise.race([extractionExit, sleep(5000)]);
    resetAuthentication();
  } finally {
    cdp?.close();
    if (extractionChrome.exitCode === null) extractionChrome.kill("SIGTERM");
  }
}

/** Read YouTube's selection, not just the Google login shared by its channels.
 * @param {CdpConnection} cdp
 */
async function readChromeAccount(cdp) {
  const { targetId } = await cdp.request("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.request("Target.attachToTarget", { targetId, flatten: true });
  await cdp.request("Page.navigate", { url: "https://www.youtube.com/" }, sessionId);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { result } = await cdp.request("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        if (document.readyState !== 'complete' || !window.ytcfg?.get) return null;
        const get = (key) => window.ytcfg.get(key);
        if (get('LOGGED_IN') !== true || get('SESSION_INDEX') == null) return null;
        return {
          account_index: Number(get('SESSION_INDEX')),
          on_behalf_of_user: get('DELEGATED_SESSION_ID') ||
            get('INNERTUBE_CONTEXT')?.user?.onBehalfOfUser || undefined
        };
      })()`,
    }, sessionId).catch((error) => {
      // A navigation/redirect may replace the execution context between polls.
      if (/execution context was destroyed|cannot find context/i.test(errorMessage(error))) return {};
      throw error;
    });
    const selected = result?.value;
    if (selected && Number.isSafeInteger(selected.account_index) && selected.account_index >= 0 &&
        (selected.on_behalf_of_user === undefined || typeof selected.on_behalf_of_user === "string")) {
      return /** @type {{ account_index: number, on_behalf_of_user?: string }} */ (selected);
    }
    await sleep(200);
  }
  throw new WorkerError("CHROME_LOGIN_FAILED", "Could not read the selected YouTube account; login was not saved");
}

/**
 * @param {any} button
 * @returns {"show" | "hide" | undefined}
 */
function heldButtonKind(button) {
  const label = [
    button?.text,
    button?.label,
    button?.tooltip,
    button?.accessibility?.accessibility_data?.label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (label.includes("show") || label.includes("approve")) return "show";
  if (label.includes("hide") || label.includes("reject")) return "hide";
  return undefined;
}

/** @param {unknown} value */
function send(value) {
  protocolOutput.write(`${JSON.stringify(value)}\n`);
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
function sendEvent(event, fields = {}) {
  workerBridge?.sendEvent("innertube/event", { type: "event", event, ...fields });
}

async function readCookie() {
  const cookieFile = cookieFilePath();
  try {
    return (await fs.readFile(cookieFile, "utf8"))
      .trim()
      .replace(/^cookie:\s*/i, "");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

/** @returns {Promise<YouTubeClient>} */
async function getYouTube() {
  if (youtube) return youtube;
  if (!cookie) {
    cookieFileValue = await readCookie();
    loadAuthentication(cookieFileValue);
  }
  /** @type {Parameters<typeof Innertube.create>[0]} */
  const options = {
    ...accountContext,
    cookie: cookie
      ? /** @type {string} */ (/** @type {unknown} */ (cookieProxy))
      : undefined,
    fetch: youtubeFetch,
    lang: "en",
    location: "CA",
    timezone: "America/Toronto",
    retrieve_player: false,
  };
  const userAgent = process.env.YT_STREAM_MODBOT_USER_AGENT;
  if (userAgent) options.user_agent = userAgent;
  youtube = await Innertube.create(options);
  if (userAgent) applyUserAgentContext(youtube, userAgent);
  return youtube;
}

/**
 * Keep youtubei.js's request context consistent when a custom browser identity
 * is used, including when its locally-generated Windows/Chrome fallback runs.
 *
 * @param {YouTubeClient} client
 * @param {string} userAgent
 */
function applyUserAgentContext(client, userAgent) {
  const context = client.session.context.client;
  context.userAgent = userAgent;

  const macOS = userAgent.match(/Macintosh; Intel Mac OS X ([\d_]+)/);
  if (macOS) {
    context.osName = "Macintosh";
    context.osVersion = macOS[1];
  } else {
    const windows = userAgent.match(/Windows NT ([\d.]+)/);
    if (windows) {
      context.osName = "Windows";
      context.osVersion = windows[1];
    } else if (/\bLinux\b/.test(userAgent)) {
      context.osName = "Linux";
      context.osVersion = "";
    }
  }

  const edge = userAgent.match(/Edg\/([\d.]+)/);
  const chrome = userAgent.match(/Chrome\/([\d.]+)/);
  const firefox = userAgent.match(/Firefox\/([\d.]+)/);
  const safari = userAgent.match(/Version\/([\d.]+).*Safari\//);
  if (edge) {
    context.browserName = "Edge";
    context.browserVersion = edge[1];
  } else if (chrome) {
    context.browserName = "Chrome";
    context.browserVersion = chrome[1];
  } else if (firefox) {
    context.browserName = "Firefox";
    context.browserVersion = firefox[1];
  } else if (safari) {
    context.browserName = "Safari";
    context.browserVersion = safari[1];
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function expiredAuthenticationError() {
  return new WorkerError(
    "AUTH_EXPIRED",
    "YouTube cookies are expired or no longer authenticated; log in again",
  );
}

/** @param {unknown} error */
function isAuthenticationFailure(error) {
  if (
    error instanceof WorkerError &&
    (error.code === "AUTH_EXPIRED" || error.status === 401)
  ) {
    return true;
  }
  return /\b401\b|not authenticated|unauthenticated|unauthorized|sign(?:ed)?[ -]?in/i.test(
    errorMessage(error),
  );
}

async function refreshChangedCookie() {
  const latestCookie = await readCookie();
  if (latestCookie === cookieFileValue) return;
  loadAuthentication(latestCookie);
  cookieFileValue = latestCookie;
  resetAuthentication();
}

async function ensureAuthentication() {
  await refreshChangedCookie();
  if (!cookie) {
    throw new WorkerError(
      "NOT_AUTHENTICATED",
      "InnerTube enforcement requires a raw YouTube Cookie header file",
    );
  }
  if (authenticationState === "expired") throw expiredAuthenticationError();
  await getYouTube();
  authenticationState = "valid";
}

async function detectStartupAuthentication() {
  await refreshChangedCookie();
  authenticatedChannelId = null;
  authenticatedChannelHandle = null;
  authenticatedChannelName = null;
  authenticatedChannelAvatarUrl = null;
  identityRetryAt = Date.now() + 30_000;
  if (!cookie) return { status: "missing" };

  try {
    const client = await getYouTube();
    const accounts = await client.account.getInfo(true);
    const active = accounts.find((account) => account.is_selected) || accounts[0];
    if (!active) {
      authenticationState = "expired";
      return { status: "unauthenticated" };
    }

    authenticationState = "valid";
    const handle = active.is_selected || accounts.length === 1
      ? String(active.channel_handle || "") : "";
    authenticatedChannelHandle = handle.startsWith("@") ? handle : null;
    authenticatedChannelName = String(active.account_name || "") || null;
    authenticatedChannelAvatarUrl = imageUrl(active.account_photo) || null;
    if (handle.startsWith("@")) {
      try {
        authenticatedChannelId = await resolveChannel(handle);
      } catch (error) {
        stderr("could not resolve authenticated channel identity:", errorMessage(error));
      }
    }
    return {
      status: "authenticated",
      channel_id: authenticatedChannelId,
      account_name: String(active.account_name || "") || undefined,
      channel_handle: String(active.channel_handle || "") || undefined,
      channel_avatar_url: authenticatedChannelAvatarUrl || undefined,
    };
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      authenticationState = "expired";
      return { status: "unauthenticated" };
    }
    authenticationState = "unknown";
    return { status: "check_failed", error: errorMessage(error) };
  }
}

/** @param {string} videoId */
function requireModerationPermission(videoId) {
  const presence = getModerationPresence(videoId);
  if (!presence || presence.is_moderator) return;
  throw new WorkerError(
    "NOT_A_MODERATOR",
    `This account is not a moderator for ${videoId}`,
  );
}

async function revalidateAuthenticationAfterFailure() {
  youtube = undefined;
  authenticationState = "unknown";
  const result = await detectStartupAuthentication();
  if (result.status === "authenticated") {
    stderr("enforcement authentication revalidated successfully");
    return true;
  }
  if (result.status === "unauthenticated" || result.status === "missing") {
    authenticationState = "expired";
    stderr(`enforcement disabled: session revalidation returned ${result.status}`);
    return false;
  }
  stderr(`enforcement authentication revalidation inconclusive: ${result.error}`);
  return undefined;
}

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {boolean} [enforcement]
 * @returns {Promise<T>}
 */
async function authenticated(operation, enforcement = false) {
  await ensureAuthentication();
  try {
    return await operation();
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      if (enforcement) {
        const valid = await revalidateAuthenticationAfterFailure();
        if (valid === false) throw expiredAuthenticationError();
      } else {
        authenticationState = "expired";
      }
    }
    throw error;
  }
}

/** @param {string} target */
async function resolveChannel(target) {
  const yt = await getYouTube();
  if (resolvedTarget === target && resolvedChannelId) return resolvedChannelId;

  let channelId = target;
  if (!/^UC[\w-]{22}$/.test(target)) {
    const path = target.startsWith("@") ? target : `@${target}`;
    const endpoint = await yt.resolveURL(`https://www.youtube.com/${path}`);
    channelId = endpoint.payload?.browseId;
  }
  if (typeof channelId !== "string" || !/^UC[\w-]{22}$/.test(channelId)) {
    throw new WorkerError("TARGET_NOT_FOUND", `Could not resolve ${target}`);
  }
  resolvedTarget = target;
  resolvedChannelId = channelId;
  return channelId;
}

/** @param {any} stream */
function streamVideoId(stream) {
  const videoId = stream?.video_id || stream?.content_id;
  return typeof videoId === "string" && videoId ? videoId : undefined;
}

/** @param {any} stream */
function streamIsLive(stream) {
  if (typeof stream?.is_live === "boolean") return stream.is_live;
  const overlays = stream?.content_image?.overlays;
  if (!Array.isArray(overlays)) return false;
  return overlays.some(
    (/** @type {any} */ overlay) =>
      Array.isArray(overlay?.badges) &&
      overlay.badges.some(
        (/** @type {any} */ badge) =>
          badge?.icon_name === "LIVE" ||
          badge?.badge_style === "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE" ||
          badge?.text === "LIVE",
      ),
  );
}

/** @param {{ target: string }} request */
async function discover({ target }) {
  if (!target) throw new WorkerError("INVALID_REQUEST", "target is required");
  const yt = await getYouTube();
  const channelId = await resolveChannel(target);
  const channel = await yt.getChannel(channelId);
  if (!channel.has_live_streams) return { streams: [] };

  const streams = await channel.getLiveStreams();
  const discovered = new Map();
  for (const rawVideo of streams.videos) {
    /** @type {any} */
    const video = rawVideo;
    const videoId = streamVideoId(video);
    if (!videoId || !streamIsLive(video)) continue;
    const title =
      typeof video.title === "string"
        ? video.title
        : typeof video.title?.text === "string"
          ? video.title.text
          : typeof video.metadata?.title?.text === "string"
            ? video.metadata.title.text
            : "";
    if (video.author?.id) {
      videoContexts.set(videoId, {
        ...videoContexts.get(videoId),
        owner_channel_id: video.author.id,
      });
    }
    const context = await ensureVideoContext(videoId);
    discovered.set(videoId, {
      video_id: videoId,
      title,
      owner_channel_id: context.owner_channel_id,
      owner_name: context.owner_channel_id === channelId
        ? (target.startsWith('@') ? target : channel.metadata?.title || null)
        : video.author?.name || null,
      owner_avatar_url: context.owner_channel_id === channelId
        ? channel.metadata?.avatar?.[0]?.url || null
        : video.author?.thumbnails?.[0]?.url || null,
    });
  }
  return {
    streams: [...discovered.values()],
  };
}

/** @param {string} videoId */
async function ensureVideoContext(videoId) {
  const existing = videoContexts.get(videoId);
  if (existing?.owner_channel_id) return existing;
  const yt = await getYouTube();
  const info = await yt.getInfo(videoId, { client: "WEB" });
  const ownerChannelId = info.basic_info?.channel_id;
  if (!ownerChannelId) {
    throw new WorkerError(
      "VIDEO_CONTEXT_MISSING",
      `Could not determine the owner of video ${videoId}`,
    );
  }
  const context = { owner_channel_id: ownerChannelId, info };
  videoContexts.set(videoId, context);
  return context;
}

/** @param {{ video_id: string }} request */
async function inspectStream({ video_id: videoId }) {
  if (!videoId) throw new WorkerError("INVALID_REQUEST", "video_id is required");
  const context = await ensureVideoContext(videoId);
  const info = context.info;
  return {
    video_id: videoId,
    title: String(info?.basic_info?.title || ""),
    owner_channel_id: context.owner_channel_id,
    owner_name: null,
    owner_avatar_url: null,
  };
}

/** @param {{ video_id: string, subscription_id: string, buffer_size?: number }} request */
async function subscribe({ video_id: videoId, subscription_id: subscriptionId, buffer_size: bufferSize = 2500 }) {
  const subscribedAt = Date.now();
  if (!videoId || !subscriptionId) {
    throw new WorkerError(
      "INVALID_REQUEST",
      "video_id and subscription_id are required",
    );
  }
  if (subscriptions.has(subscriptionId)) {
    throw new WorkerError(
      "INVALID_REQUEST",
      `subscription ${subscriptionId} already exists`,
    );
  }

  const yt = await getYouTube();
  const context = await ensureVideoContext(videoId);
  const info = context.info || (await yt.getInfo(videoId, { client: "WEB" }));
  const ownerChannelId = info.basic_info?.channel_id;
  if (!ownerChannelId) {
    throw new WorkerError(
      "VIDEO_CONTEXT_MISSING",
      `Could not determine the owner of video ${videoId}`,
    );
  }
  context.owner_channel_id = ownerChannelId;
  let liveChat;
  try {
    liveChat = info.getLiveChat();
  } catch (error) {
    throw new WorkerError("NOT_LIVE", errorMessage(error), false);
  }
  /** @type {SubscriptionState} */
  const state = {
    live_chat: liveChat,
    video_id: videoId,
    owner_channel_id: context.owner_channel_id,
    last_error: undefined,
    retry_attempts: 0,
  };
  subscriptions.set(subscriptionId, state);
  const items = new ChatItems(videoId, bufferSize);
  state.resolve_review = (messageId, reviewState) => {
    items.resolveReview(messageId, reviewState);
  };
  let pinnedActionId = '';

  const recovered = (newConnection = false) => {
    if (state.retry_attempts || newConnection) {
      sendEvent("subscription_recovered", {
        subscription_id: subscriptionId, video_id: videoId,
      });
    }
    state.retry_attempts = 0;
    state.last_error = undefined;
  };
  liveChat.smoothed_queue = /** @type {any} */ (
    new ImmediateActionQueue(liveChat.smoothed_queue.callback, recovered)
  );

  /** @param {any} action @param {boolean} [historical] */
  const handleChatUpdate = (action, historical = false) => {
    if (process.env.YT_STREAM_MODBOT_TRACE_EVENTS === '1') {
      try {
        sendEvent('trace_action', { subscription_id: subscriptionId, video_id: videoId, historical, action });
      } catch (error) {
        stderr('event trace serialization failed:', error);
      }
    }
    if (action?.type === 'AddBannerToLiveChatCommand') {
      const banner = action.banner;
      const item = banner?.contents;
      const normalized = normalizedChatItem(item, state.owner_channel_id);
      if (normalized && banner.action_id) {
        pinnedActionId = banner.action_id;
        if (normalized.menu_endpoint) retainRecent(messageMenus, normalized.id, { endpoint: normalized.menu_endpoint, video_id: videoId });
        sendEvent('pinned', { subscription_id: subscriptionId, message: {
          id: pinnedActionId,
          message: {
            id: normalized.id, live_chat_id: videoId,
            author_channel_id: String(normalized.author.id), author_name: String(normalized.author.name || '') || null,
            author_avatar_url: normalized.author.thumbnails?.[0]?.url || null,
            author_is_moderator: Boolean(normalized.author.is_moderator) || normalized.is_owner,
            author_is_owner: normalized.is_owner,
            text: normalized.text,
            event_kind: normalized.event_kind, event_text: normalized.event_text,
            purchase_amount: normalized.purchase_amount, event_image_url: normalized.event_image_url,
            event_image_alt: normalized.event_image_alt, jewels_amount: normalized.jewels_amount,
            moderatable_text: normalized.moderatable_text,
            timestamp: new Date(normalized.timestamp).toISOString(),
            source: 'youtube', historical: true,
          },
          text: normalized.text || normalized.event_text || '',
          author_channel_id: normalized.author.id || null,
          author_name: String(normalized.author.name || '') || null,
          author_avatar_url: normalized.author.thumbnails?.[0]?.url || null,
          timestamp: new Date(normalized.timestamp).toISOString(),
          removed: false,
        } });
      }
      return;
    }
    if (action?.type === 'RemoveBannerForLiveChatCommand') {
      if (pinnedActionId && action.target_action_id === pinnedActionId) {
        sendEvent('pinned', { subscription_id: subscriptionId, message: { id: pinnedActionId, removed: true } });
        pinnedActionId = '';
      }
      return;
    }
    if (action?.type === "ReplayChatItemAction" || action?.type === "CommandExecutorCommand") {
      for (const child of action.actions || action.commands || []) handleChatUpdate(child, historical);
      return;
    }
    const notice = action?.item || action?.replacement_item;
    if (notice?.type === LiveChatModerationMessage.type) {
      if (notice.id && notice.text) sendEvent("moderation", {
        subscription_id: subscriptionId,
        message: { id: notice.id, text: notice.text, timestamp: notice.timestamp },
      });
      return;
    }
    if (action?.type === LiveChatReportPresenceCommand.type) {
      if (!action.video_id || action.video_id !== videoId || !action.channel_id) {
        stderr(
          `ignored invalid live chat presence video_id=${action?.video_id || "missing"}`,
        );
        return;
      }
      const presence = {
        channel_id: action.channel_id,
        is_moderator: Boolean(action.is_moderator),
        present_at_ms: action.present_at_ms,
      };
      const previous = setModerationPresence(videoId, presence);
      if (authenticatedChannelId) {
        const isOwner = authenticatedChannelId === state.owner_channel_id;
        sendEvent("identity", {
          subscription_id: subscriptionId,
          profile: {
            author_channel_id: authenticatedChannelId,
            author_name: authenticatedChannelHandle || authenticatedChannelName,
            author_avatar_url: authenticatedChannelAvatarUrl,
            is_moderator: Boolean(isOwner || presence.is_moderator),
            is_owner: isOwner,
          },
        });
      }
      if (
        !previous ||
        previous.channel_id !== presence.channel_id ||
        previous.is_moderator !== presence.is_moderator
      ) {
        stderr(
          `live chat presence video_id=${videoId} channel_id=${presence.channel_id} ` +
            `moderator=${presence.is_moderator}`,
        );
      }
      return;
    }
    for (const { entry, added } of items.apply(action)) {
      const outerItem = entry.item;
      const heldForReview = Boolean(outerItem?.auto_moderated_item);
      const item = heldForReview ? outerItem.auto_moderated_item : outerItem?.message ? outerItem : entry.original;
      const normalized = normalizedChatItem(item || outerItem, state.owner_channel_id);
      const messageId = heldForReview ? normalized?.id || outerItem?.id : normalized?.id;
      if (!messageId || !normalized) continue;
      const author = normalized.author;
      const menuEndpoint = normalized.menu_endpoint || outerItem?.menu_endpoint;
      if (menuEndpoint) {
        retainRecent(messageMenus, String(messageId), { endpoint: menuEndpoint, video_id: videoId });
      }
      if (heldForReview && !entry.removal) {
        /** @type {{ show?: any, hide?: any }} */
        const endpoints = {};
        for (const button of outerItem.moderation_buttons || []) {
          const kind = heldButtonKind(button);
          if (kind) endpoints[kind] = button.endpoint;
        }
        retainRecent(heldReviewActions, String(messageId), endpoints);
      } else if (!items.items.some(({ item: current }) => current.auto_moderated_item?.id === messageId)) {
        heldReviewActions.delete(String(messageId));
      }
      const timestamp = Number(heldForReview ? outerItem?.timestamp || normalized.timestamp : normalized.timestamp);
      sendEvent(added ? "message" : "message_update", {
        subscription_id: subscriptionId,
        message: {
          id: String(messageId),
          item_key: entry.key,
          video_id: videoId,
          author_channel_id: String(author.id),
          author_name: String(author.name || "") || null,
          author_avatar_url: author.thumbnails?.[0]?.url || null,
          text: normalized.text,
          event_kind: normalized.event_kind,
          event_text: normalized.event_text,
          purchase_amount: normalized.purchase_amount,
          event_image_url: normalized.event_image_url,
          event_image_alt: normalized.event_image_alt,
          jewels_amount: normalized.jewels_amount,
          moderatable_text: normalized.moderatable_text,
          timestamp:
            Number.isFinite(timestamp) && timestamp > 0
              ? new Date(timestamp).toISOString()
              : new Date().toISOString(),
          is_moderator: Boolean(author.is_moderator),
          is_owner: author.id === state.owner_channel_id,
          held_for_review: entry.wasHeld,
          review_state: entry.reviewState,
          removal: entry.removal ? { ...entry.removal, message_id: String(messageId), author_channel_id: null } : null,
          // Updates and public backlog are display-only, never another graph activation.
          historical: !added || Boolean(entry.removal) || (!heldForReview && (historical ||
            (Number.isFinite(timestamp) && timestamp > 0 && timestamp < subscribedAt))),
        },
      });
    }
  };
  state.handle_action = handleChatUpdate;

  liveChat.on("start", (/** @type {any} */ contents) => {
    recovered(true);
    try {
      liveChat.applyFilter("LIVE_CHAT");
    } catch (error) {
      stderr("could not switch to Live chat:", error);
    }
    // Keep the entire initial snapshot for the console. Public backlog is
    // display-only; pending held messages still follow the live review path.
    for (const action of contents?.actions || []) {
      handleChatUpdate(action, true);
    }
  });
  liveChat.on("chat-update", handleChatUpdate);
  liveChat.on("error", (/** @type {unknown} */ error) => {
    // Keep the underlying network error when youtubei.js subsequently emits
    // its retry-limit wrapper. The reader reports the outage on subscription_end.
    if (
      errorMessage(error) === "Reached retry limit for incremental continuation requests" &&
      isTransientNetworkError(state.last_error)
    ) return;
    state.last_error = error;
    if (isTransientNetworkError(error)) {
      sendEvent("subscription_retry", {
        subscription_id: subscriptionId, video_id: videoId,
        attempt: ++state.retry_attempts, error: publicError(error),
      });
    } else {
      stderr(`live chat ${videoId}:`, error);
    }
  });
  liveChat.once("end", () => {
    if (subscriptions.get(subscriptionId) !== state) return;
    subscriptions.delete(subscriptionId);
    sendEvent("subscription_end", {
      subscription_id: subscriptionId,
      error: state.last_error ? publicError(state.last_error) : null,
    });
  });

  // The response is written by the request dispatcher before this starts.
  queueMicrotask(() => liveChat.start());
  return { subscription_id: subscriptionId };
}

/** @param {{ subscription_id: string }} request */
async function unsubscribe({ subscription_id: subscriptionId }) {
  const state = subscriptions.get(subscriptionId);
  if (!state) return { stopped: false };
  subscriptions.delete(subscriptionId);
  state.live_chat.stop();
  return { stopped: true };
}

/** @param {number | bigint} input */
function encodeVarint(input) {
  let value = BigInt(input);
  if (value < 0n) throw new WorkerError("PROTOBUF_ERROR", "negative varint");
  const output = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    output.push(byte);
  } while (value);
  return Buffer.from(output);
}

/**
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {[bigint, number]}
 */
function decodeVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let position = offset;
  while (position < buffer.length && shift <= 63n) {
    const byte = buffer[position++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, position];
    shift += 7n;
  }
  throw new WorkerError("PROTOBUF_ERROR", "invalid protobuf varint");
}

/**
 * @param {number} field
 * @param {number} wire
 * @param {Buffer} payload
 */
function protobufField(field, wire, payload) {
  return Buffer.concat([encodeVarint((field << 3) | wire), payload]);
}

/**
 * @param {number} field
 * @param {number | bigint} value
 */
function protobufInteger(field, value) {
  return protobufField(field, 0, encodeVarint(value));
}

/**
 * @param {number} field
 * @param {string | Buffer} value
 */
function protobufBytes(field, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return protobufField(field, 2, Buffer.concat([encodeVarint(bytes.length), bytes]));
}

/**
 * @param {number} field
 * @param {Buffer[]} fields
 */
function protobufMessage(field, fields) {
  return protobufBytes(field, Buffer.concat(fields));
}

/**
 * @param {string} ownerChannelId
 * @param {string} videoId
 */
function streamIdentity(ownerChannelId, videoId) {
  return protobufMessage(5, [
    protobufBytes(1, ownerChannelId),
    protobufBytes(2, videoId),
  ]);
}

/** @param {Buffer} buffer */
function wrapParams(buffer) {
  return Buffer.from(
    encodeURIComponent(buffer.toString("base64")),
    "utf8",
  ).toString("base64");
}

/** @param {string} params */
function unwrapParams(params) {
  const outer = Buffer.from(params, "base64").toString("utf8");
  return Buffer.from(decodeURIComponent(outer), "base64");
}

/**
 * @param {string} ownerChannelId
 * @param {string} videoId
 * @param {string} targetChannelId
 * @param {string | undefined} messageId
 * @param {string | undefined} messageId
 */
function contextMenuParams(ownerChannelId, videoId, targetChannelId, messageId) {
  const fields = [];
  if (messageId) {
    fields.push(
      protobufMessage(1, [
        protobufMessage(1, [protobufBytes(1, messageId)]),
      ]),
    );
  }
  fields.push(
    protobufMessage(3, [streamIdentity(ownerChannelId, videoId)]),
  );
  if (messageId) {
    fields.push(protobufInteger(4, 1), protobufInteger(5, 1));
  }
  fields.push(
    protobufMessage(6, [protobufBytes(1, targetChannelId)]),
  );
  if (messageId) {
    fields.push(
      protobufInteger(7, 2),
      protobufInteger(9, 0),
      protobufInteger(10, 1),
    );
  }
  return wrapParams(
    Buffer.concat(fields),
  );
}

/**
 * @param {Buffer} buffer
 * @returns {ProtoNode[]}
 */
function parseMessage(buffer) {
  /** @type {ProtoNode[]} */
  const nodes = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, afterTag] = decodeVarint(buffer, offset);
    offset = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!field) throw new WorkerError("PROTOBUF_ERROR", "field zero");
    if (wire === 0) {
      const [value, afterValue] = decodeVarint(buffer, offset);
      offset = afterValue;
      nodes.push({ field, wire, value });
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new WorkerError("PROTOBUF_ERROR", "truncated fixed64");
      nodes.push({ field, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const [lengthValue, afterLength] = decodeVarint(buffer, offset);
      const length = Number(lengthValue);
      offset = afterLength;
      if (offset + length > buffer.length) throw new WorkerError("PROTOBUF_ERROR", "truncated bytes");
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      let children;
      try {
        children = value.length ? parseMessage(value) : undefined;
      } catch {
        children = undefined;
      }
      nodes.push({ field, wire, value, children });
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new WorkerError("PROTOBUF_ERROR", "truncated fixed32");
      nodes.push({ field, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new WorkerError("PROTOBUF_ERROR", `unsupported wire type ${wire}`);
    }
  }
  return nodes;
}

/**
 * @param {ProtoNode[]} nodes
 * @returns {Buffer}
 */
function encodeMessage(nodes) {
  return Buffer.concat(
    nodes.map((node) => {
      if (node.wire === 0) {
        return protobufInteger(node.field, /** @type {bigint} */ (node.value));
      }
      if (node.wire === 2) {
        return protobufBytes(
          node.field,
          node.children
            ? encodeMessage(node.children)
            : /** @type {Buffer} */ (node.value),
        );
      }
      return protobufField(
        node.field,
        node.wire,
        /** @type {Buffer} */ (node.value),
      );
    }),
  );
}

/**
 * @param {ProtoNode[]} nodes
 * @param {number} previous
 * @param {number} replacement
 */
function replaceUniqueInteger(nodes, previous, replacement) {
  /** @type {ProtoNode[]} */
  const matches = [];
  /** @param {ProtoNode[]} children */
  const visit = (children) => {
    for (const node of children) {
      if (node.wire === 0 && node.value === BigInt(previous)) matches.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  if (matches.length !== 1) {
    throw new WorkerError(
      "TIMEOUT_SCHEMA_UNKNOWN",
      `expected one ${previous}s duration field, found ${matches.length}`,
    );
  }
  matches[0].value = BigInt(replacement);
}

/** @param {any} value */
function textValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (typeof value.simpleText === "string") return value.simpleText;
  if (Array.isArray(value.runs)) {
    return value.runs
      .map((/** @type {any} */ run) => run?.emoji?.shortcuts?.[0] || run?.text || "")
      .join("");
  }
  // youtubei.js Text objects retain the actual optional value here. Their
  // toString() substitutes a display placeholder when this field is absent.
  if (Object.hasOwn(value, "text")) {
    return typeof value.text === "string" ? value.text : "";
  }
  const rendered = String(value);
  return rendered === "[object Object]" ? "" : rendered;
}

/** @param {DynamicObject} renderer */
function rendererLabel(renderer) {
  return (
    textValue(renderer.text) ||
    textValue(renderer.title) ||
    renderer.accessibility?.accessibilityData?.label ||
    renderer.accessibilityData?.label ||
    ""
  );
}

/** @param {unknown} root */
function collectMenuDetails(root) {
  /** @type {ModerationCandidate[]} */
  const candidates = [];
  /** @type {MenuRenderer[]} */
  const renderers = [];
  /** @type {string | undefined} */
  let selfRemovalParams;
  /** @param {any} value */
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    const deleteParams = value.deleteLiveChatMessageCommand?.params;
    if (typeof deleteParams === "string" && deleteParams) selfRemovalParams ??= deleteParams;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith("Renderer") && child && typeof child === "object") {
        renderers.push({
          renderer: child,
          label: rendererLabel(child),
          icon: child.icon?.iconType || "",
        });
      }
      visit(child);
    }
  };
  visit(root);

  for (const detail of renderers) {
    /** @param {any} value */
    const findModerate = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.moderateLiveChatEndpoint?.params) {
        candidates.push({
          params: value.moderateLiveChatEndpoint.params,
          label: detail.label,
          icon: detail.icon,
        });
        return;
      }
      for (const child of Object.values(value)) findModerate(child);
    };
    findModerate(detail.renderer);
  }
  return { candidates, renderers, selfRemovalParams };
}

/** @param {string} label */
function secondsFromLabel(label) {
  const match = label.toLowerCase().match(/(\d+)\s*(second|minute|hour|day)/);
  if (!match) return undefined;
  /** @type {Record<string, number>} */
  const multipliers = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
  };
  const multiplier = multipliers[match[2]];
  if (multiplier === undefined) return undefined;
  return Number(match[1]) * multiplier;
}

/** @param {DynamicObject} endpointData @param {string} videoId */
async function callRawEndpoint(endpointData, videoId) {
  const yt = await getYouTube();
  const endpoint = new YTNodes.NavigationEndpoint(endpointData);
  const response = await endpoint.call(yt.actions);
  dispatchChatResponse(response?.data, videoId);
  if (!response?.success) {
    throw new WorkerError(
      "YOUTUBE_REJECTED",
      `YouTube returned ${response?.status_code || "an error"}`,
      response?.status_code >= 500 || response?.status_code === 429,
      response?.status_code,
    );
  }
  return response.data;
}

/**
 * @param {string} videoId
 * @param {string} targetChannelId
 * @param {string | undefined} messageId
 */
async function contextMenu(videoId, targetChannelId, messageId) {
  const yt = await getYouTube();
  const context = await ensureVideoContext(videoId);
  const response = await yt.actions.execute("/live_chat/get_item_context_menu", {
    params: contextMenuParams(
      context.owner_channel_id,
      videoId,
      targetChannelId,
      messageId,
    ),
  });
  dispatchChatResponse(response.data, videoId);
  if (!response.success) {
    throw new WorkerError(
      "YOUTUBE_REJECTED",
      `context menu returned ${response.status_code}`,
      response.status_code >= 500 || response.status_code === 429,
      response.status_code,
    );
  }
  return response.data;
}

/** @param {string} messageId */
async function messageContextMenu(messageId) {
  const endpoint = messageMenus.get(messageId)?.endpoint;
  if (!endpoint) {
    throw new WorkerError(
      "MESSAGE_CONTEXT_MISSING",
      `No context-menu endpoint is retained for message ${messageId}`,
    );
  }
  let response;
  if (endpoint.command || endpoint.metadata?.api_url) {
    response = await endpoint.call((await getYouTube()).actions);
  } else if (
    endpoint.payload &&
    typeof endpoint.payload === "object" &&
    Object.keys(endpoint.payload).length
  ) {
    // Some generic NavigationEndpoint shapes retain the request but not the
    // route. The route is fixed for a message context menu.
    response = await (await getYouTube()).actions.execute(
      "/live_chat/get_item_context_menu",
      endpoint.payload,
    );
  } else {
    throw new WorkerError(
      "MESSAGE_CONTEXT_MISSING",
      `The retained context-menu endpoint for ${messageId} has no payload`,
    );
  }
  const videoId = messageMenus.get(messageId)?.video_id;
  if (videoId) dispatchChatResponse(response.data, videoId);
  if (!response.success) {
    throw new WorkerError(
      "YOUTUBE_REJECTED",
      `context menu returned ${response.status_code}`,
      response.status_code >= 500 || response.status_code === 429,
      response.status_code,
    );
  }
  return response.data;
}

/**
 * @param {string} videoId
 * @param {string} targetChannelId
 * @param {string | undefined} messageId
 */
async function timeoutCandidates(videoId, targetChannelId, messageId) {
  const first =
    messageId && messageMenus.has(messageId)
      ? await messageContextMenu(messageId)
      : await contextMenu(videoId, targetChannelId, messageId);
  let details = collectMenuDetails(first);
  let candidates = details.candidates.filter(
    (candidate) =>
      candidate.icon === "HOURGLASS" || secondsFromLabel(candidate.label),
  );
  if (candidates.some((candidate) => secondsFromLabel(candidate.label))) {
    return candidates;
  }

  const trigger = details.renderers.find((detail) => detail.icon === "HOURGLASS");
  if (trigger) {
    const endpointData =
      trigger.renderer.serviceEndpoint ||
      trigger.renderer.navigationEndpoint ||
      trigger.renderer.endpoint;
    if (endpointData) {
      const second = await callRawEndpoint(endpointData, videoId);
      details = collectMenuDetails(second);
      candidates = details.candidates.filter(
        (candidate) => secondsFromLabel(candidate.label) !== undefined,
      );
    }
  }

  // Older YouTube menus expose a single direct five-minute timeout.
  if (!candidates.length) {
    const legacy = collectMenuDetails(first).candidates.find(
      (candidate) => candidate.icon === "HOURGLASS",
    );
    if (legacy) candidates.push({ ...legacy, known_seconds: 300 });
  }
  return candidates;
}

/** @param {string} videoId @param {string} params */
async function moderateParams(videoId, params) {
  const yt = await getYouTube();
  const requestStartedAt = Math.floor(Date.now() / 1000);
  const response = await yt.actions.execute("/live_chat/moderate", { params });
  dispatchChatResponse(response.data, videoId);
  const apiError = response.data?.error;
  if (!response.success || apiError || response.data?.success !== true) {
    const status =
      typeof apiError?.code === "number" ? apiError.code : response.status_code;
    const actions = Array.isArray(response.data?.actions) ? response.data.actions : [];
    const toast = actions.map((/** @type {any} */ action) => {
      const item = action?.liveChatAddToToastAction?.item;
      return rawText(item?.notificationTextRenderer?.successResponseText) ||
        rawText(item?.notificationActionRenderer?.responseText);
    }).find(Boolean);
    const message = apiError?.message || toast ||
      `YouTube did not confirm moderation success (HTTP ${response.status_code})`;
    throw new WorkerError(
      "YOUTUBE_REJECTED",
      message,
      status >= 500 || status === 429,
      status,
    );
  }
  return { ...response.data, request_started_at: requestStartedAt };
}

/** @param {{ message_id: string, video_id?: string }} request */
async function removeMessage({ message_id: messageId, video_id: videoId }) {
  const stream = videoId || messageMenus.get(messageId)?.video_id;
  const menu = await messageContextMenu(messageId);
  const { candidates, selfRemovalParams } = collectMenuDetails(menu);
  // Use only the self-removal command actually offered by YouTube. It does not
  // require moderator privileges; other removal commands still do.
  if (selfRemovalParams) {
    const response = await (await getYouTube()).actions.execute(
      "/live_chat/delete_message", { params: selfRemovalParams },
    );
    if (stream) dispatchChatResponse(response.data, stream);
    const apiError = response.data?.error;
    if (!response.success || apiError || response.data?.success === false) {
      const status = typeof apiError?.code === "number" ? apiError.code : response.status_code;
      throw new WorkerError(
        "YOUTUBE_REJECTED", apiError?.message || `self-removal failed (HTTP ${status})`,
        status >= 500 || status === 429, status,
      );
    }
    return response.data;
  }
  if (!stream) throw new WorkerError("MESSAGE_CONTEXT_MISSING", "No stream is retained for this message");
  requireModerationPermission(stream);
  const selected = candidates.find((candidate) => {
    const label = candidate.label.toLowerCase();
    return candidate.icon === "DELETE" || label === "remove" || label.includes("delete");
  });
  if (!selected) {
    throw new WorkerError(
      "ACTION_NOT_AVAILABLE",
      "YouTube did not offer message removal",
    );
  }
  return moderateParams(stream, selected.params);
}

/** Dispatch returned chat actions just as for continuation polling.
 * @param {any[]} actions @param {string} videoId
 */
function dispatchParsedChatActions(actions, videoId) {
  for (const action of actions) {
    for (const state of subscriptions.values()) {
      if (state.video_id !== videoId) continue;
      try {
        state.handle_action?.(action);
      } catch (error) {
        // The provider operation has already completed. A continuation echo
        // can retry local projection, so never turn that success into a
        // request failure.
        stderr("chat response projection failed:", errorMessage(error));
      }
    }
  }
}

/** Dispatch a raw command response through the same reducer as polling.
 * @param {any} data @param {string} videoId
 */
function dispatchChatResponse(data, videoId) {
  dispatchParsedChatActions(Parser.parseArray(responseActions(data)), videoId);
}

/** @param {{ message_id: string, video_id: string, allow: boolean }} request */
async function resolveHeld({ message_id: messageId, video_id: videoId, allow }) {
  requireModerationPermission(videoId);
  const endpoints = heldReviewActions.get(messageId);
  const endpoint = allow ? endpoints?.show : endpoints?.hide;
  if (!endpoint) {
    throw new WorkerError(
      "ACTION_NOT_AVAILABLE",
      `YouTube did not offer ${allow ? "Show" : "Hide"} for held message ${messageId}`,
    );
  }
  const response = await endpoint.call((await getYouTube()).actions);
  const apiError = response.data?.error;
  if (response.success && !apiError) {
    for (const state of subscriptions.values()) {
      if (state.video_id === videoId) {
        state.resolve_review?.(messageId, allow ? "shown" : "hidden");
      }
    }
  }
  dispatchChatResponse(response.data, videoId);
  if (!response.success || apiError) {
    const status = typeof apiError?.code === "number" ? apiError.code : response.status_code;
    throw new WorkerError(
      "YOUTUBE_REJECTED",
      apiError?.message || `held-message review returned ${status}`,
      status >= 500 || status === 429,
      status,
    );
  }
  return {};
}

/** @param {any} candidate */
function isHideCandidate(candidate) {
  const label = candidate.label.toLowerCase();
  return candidate.icon === "REMOVE_CIRCLE" || /\bhide user\b/.test(label);
}

/** @param {any} candidate */
function isUnhideCandidate(candidate) {
  const label = candidate.label.toLowerCase();
  return candidate.icon === "ADD_CIRCLE" || /\bunhide user\b/.test(label);
}

/** Read channel-wide visibility from the action YouTube offers, without
 * invoking that action. @param {string} videoId @param {string} target
 * @param {string | undefined} messageId */
async function inspectUserVisibility(videoId, target, messageId) {
  requireModerationPermission(videoId);
  const menu =
    messageId && messageMenus.has(messageId)
      ? await messageContextMenu(messageId)
      : await contextMenu(videoId, target, messageId);
  const { candidates } = collectMenuDetails(menu);
  const hideAvailable = candidates.some(isHideCandidate);
  const unhideAvailable = candidates.some(isUnhideCandidate);
  return {
    hidden: unhideAvailable && !hideAvailable
      ? true
      : hideAvailable && !unhideAvailable ? false : null,
    hide_available: hideAvailable,
    unhide_available: unhideAvailable,
  };
}

/**
 * @param {{ video_id: string, author_channel_id: string, message_id?: string, seconds: number }} request
 */
async function timeout({
  video_id: videoId,
  author_channel_id: target,
  message_id: messageId,
  seconds,
}) {
  requireModerationPermission(videoId);
  const context = await ensureVideoContext(videoId);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new WorkerError("INVALID_REQUEST", "seconds must be a non-negative integer");
  }
  const candidates = await timeoutCandidates(videoId, target, messageId);
  if (!candidates.length) {
    throw new WorkerError("ACTION_NOT_AVAILABLE", "YouTube did not offer a timeout action");
  }

  const exact = candidates.find(
    (candidate) => (secondsFromLabel(candidate.label) ?? candidate.known_seconds) === seconds,
  );
  if (exact) {
    const response = await moderateParams(videoId, exact.params);
    return {
      ...response,
      scope: "stream",
      scope_id: videoId,
      scope_parent_id: context.owner_channel_id,
    };
  }

  const templates = candidates
    .map((candidate) => ({
      ...candidate,
      known_seconds: secondsFromLabel(candidate.label) ?? candidate.known_seconds,
    }))
    .filter((candidate) => candidate.known_seconds !== undefined)
    .sort(
      (left, right) =>
        (right.known_seconds ?? 0) - (left.known_seconds ?? 0),
    );
  if (!templates.length) {
    throw new WorkerError(
      "TIMEOUT_SCHEMA_UNKNOWN",
      "Could not identify the duration of YouTube's timeout template",
    );
  }
  const template = templates[0];
  const templateSeconds = template.known_seconds;
  if (templateSeconds === undefined) {
    throw new WorkerError(
      "TIMEOUT_SCHEMA_UNKNOWN",
      "Timeout template has no known duration",
    );
  }
  const nodes = parseMessage(unwrapParams(template.params));
  replaceUniqueInteger(nodes, templateSeconds, seconds);
  const response = await moderateParams(videoId, wrapParams(encodeMessage(nodes)));
  return {
    ...response,
    scope: "stream",
    scope_id: videoId,
    scope_parent_id: context.owner_channel_id,
  };
}

/**
 * @param {string} videoId
 * @param {string} target
 * @param {string | undefined} messageId
 * @param {"hide" | "unhide"} action
 */
async function channelVisibilityAction(videoId, target, messageId, action) {
  requireModerationPermission(videoId);
  const context = await ensureVideoContext(videoId);
  const menu =
    messageId && messageMenus.has(messageId)
      ? await messageContextMenu(messageId)
      : await contextMenu(videoId, target, messageId);
  const { candidates } = collectMenuDetails(menu);
  const selected = candidates.find((candidate) => {
    return action === "hide" ? isHideCandidate(candidate) : isUnhideCandidate(candidate);
  });
  if (!selected) {
    if (action === "hide" && candidates.some(isUnhideCandidate)) {
      throw new WorkerError("ALREADY_HIDDEN", "User is already hidden on YouTube");
    }
    if (action === "unhide" && candidates.some(isHideCandidate)) {
      throw new WorkerError("NOT_HIDDEN", "User is not hidden on YouTube");
    }
    throw new WorkerError(
      "ACTION_NOT_AVAILABLE",
      `YouTube did not offer ${action}`,
    );
  }
  const response = await moderateParams(videoId, selected.params);
  return {
    ...response,
    scope: "channel",
    scope_id: context.owner_channel_id,
    scope_parent_id: null,
  };
}

/**
 * @param {string} videoId
 * @param {string} text
 */
async function sendChatMessage(videoId, text) {
  const state = [...subscriptions.values()].find(
    (subscription) => subscription.video_id === videoId,
  );
  if (!state) {
    throw new WorkerError("CHAT_NOT_CONNECTED", "Live chat is not connected");
  }
  const actions = await state.live_chat.sendMessage(text);
  dispatchParsedChatActions(actions, videoId);
  for (const action of actions) {
    const messageId = action?.item?.id;
    if (typeof messageId === "string" && messageId) {
      if (action.item.menu_endpoint) {
        retainRecent(messageMenus, messageId, { endpoint: action.item.menu_endpoint, video_id: videoId });
      }
      return { message_id: messageId };
    }
  }
  throw new WorkerError(
    "SEND_MESSAGE_ID_MISSING",
    "YouTube did not return the sent live-chat message ID",
  );
}

/**
 * @param {string} method
 * @param {DynamicObject} params
 */
async function dispatch(method, params) {
  switch (method) {
    case "update_creator_channel":
      return authenticated(async () => updateCreatorChannel(await getYouTube(), params), true);
    case "resolve_user": {
      const target = String(params.target || "");
      if (!(target.startsWith("@") || /^UC[\w-]{22}$/.test(target))) {
        throw new WorkerError("INVALID_TARGET", "Expected @handle or channel ID");
      }
      return { channel_id: await resolveChannel(target) };
    }
    case "discover":
      return discover(/** @type {{ target: string }} */ (params));
    case "inspect_stream":
      return inspectStream(
        /** @type {{ video_id: string }} */ (params),
      );
    case "subscribe":
      return subscribe(
        /** @type {{ video_id: string, subscription_id: string }} */ (params),
      );
    case "unsubscribe":
      return unsubscribe(
        /** @type {{ subscription_id: string }} */ (params),
      );
    case "delete":
      return authenticated(
        () =>
          removeMessage(
          /** @type {{ message_id: string, video_id?: string }} */ (params),
          ),
        true,
      );
    case "resolve_held":
      return authenticated(
        () =>
          resolveHeld(
            /** @type {{ message_id: string, video_id: string, allow: boolean }} */ (
              params
            ),
          ),
        true,
      );
    case "send_message":
      return authenticated(() =>
        sendChatMessage(
          String(params.video_id || ""),
          String(params.text || ""),
        ),
      );
    case "inspect_user_visibility":
      return authenticated(
        () => inspectUserVisibility(
          String(params.video_id || ""),
          String(params.author_channel_id || ""),
          typeof params.message_id === "string" ? params.message_id : undefined,
        ),
        true,
      );
    case "timeout":
      return authenticated(
        () =>
          timeout(
            /** @type {{ video_id: string, author_channel_id: string, message_id?: string, seconds: number }} */ (
              params
            ),
          ),
        true,
      );
    case "hide":
      return authenticated(
        () =>
          channelVisibilityAction(
            params.video_id,
            params.author_channel_id,
            params.message_id,
            "hide",
          ),
        true,
      );
    case "unhide":
      return authenticated(
        () =>
          channelVisibilityAction(
            params.video_id,
            params.author_channel_id,
            params.message_id,
            "unhide",
          ),
        true,
      );
    case "login": {
      await chromeLogin();
      const authentication = await detectStartupAuthentication();
      if (authentication.status !== "authenticated") {
        throw new WorkerError(
          "CHROME_LOGIN_FAILED",
          "Chrome cookies were extracted but YouTube did not accept the session",
        );
      }
      return authentication;
    }
    case "identity":
      await refreshChangedCookie();
      if (cookie && authenticatedChannelId === null && Date.now() >= identityRetryAt) {
        await detectStartupAuthentication();
      }
      {
        const channelId = authenticationState === "valid" ? authenticatedChannelId : null;
        const presence = getModerationPresence(String(params.video_id || ""));
        const context = videoContexts.get(String(params.video_id || ""));
        const isOwner = Boolean(channelId && context?.owner_channel_id === channelId);
        const moderatorKnown = Boolean(isOwner || presence);
        return {
          channel_id: channelId,
          channel_handle: authenticationState === "valid" ? authenticatedChannelHandle : null,
          channel_name: authenticationState === "valid" ? authenticatedChannelName : null,
          channel_avatar_url: authenticationState === "valid" ? authenticatedChannelAvatarUrl : null,
          is_moderator: Boolean(isOwner || presence?.is_moderator),
          moderator_known: moderatorKnown,
          is_owner: isOwner,
        };
      }
    case "ping":
      return {
        authenticated: authenticationState === "valid",
        authentication_state: authenticationState,
        nonce: crypto.randomUUID(),
      };
    default:
      throw new WorkerError("UNKNOWN_METHOD", `Unknown method ${method}`);
  }
}

/** @param {unknown} error */
function publicError(error) {
  if (error instanceof WorkerError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  const status = httpStatus(error);
  return {
    code: "INNERTUBE_ERROR",
    message: status === undefined ? errorMessage(error) : `HTTP ${status}`,
    retryable: isTransientNetworkError(error),
    ...(status === undefined ? {} : { status }),
  };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--login") {
  try {
    await chromeLogin();
    const authentication = await detectStartupAuthentication();
    if (authentication.status !== "authenticated") {
      throw new WorkerError("CHROME_LOGIN_FAILED", "Chrome cookies were saved but YouTube did not confirm authentication");
    }
    stderr(`Chrome login succeeded; credentials saved to ${cookieFilePath()}`);
  } catch (error) {
    stderr("Chrome login failed:", publicError(error).message);
    process.exitCode = 1;
  }
} else if (args.length) {
  stderr(`Unknown argument: ${args.join(" ")}. Use --login or no arguments.`);
  process.exitCode = 1;
} else {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.once("close", () => {
    for (const state of subscriptions.values()) state.live_chat.stop();
    subscriptions.clear();
  });

  const startupAuthentication = await detectStartupAuthentication();
  send({
    type: "ready",
    protocol: 1,
    authentication: startupAuthentication,
  });
  const workerContext = new Context();
  await workerContext.plugin((ctx) => {
    const bridge = workerBridge = new CordisBridge(ctx, lineTransport(input, protocolOutput), "innertube");
    bridge.expose("innertube", {
      /** @param {string} method @param {DynamicObject} params */
      async request(method, params) {
        try {
          return { ok: true, result: await dispatch(method, params || {}) };
        } catch (error) {
          return { ok: false, error: publicError(error) };
        }
      },
    });
    ctx.provide("innertubeBridge", bridge);
    return () => bridge.close();
  });
}
