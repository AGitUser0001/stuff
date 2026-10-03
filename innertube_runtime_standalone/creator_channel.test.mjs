import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Constants, HTTPClient } from "youtubei.js";
import { studioFetchInit, updateCreatorChannel } from "./creator_channel.mjs";

function fixture() {
  let cookie = "SAPISID=mock-initial; marker=one";
  const requests = [];
  const session = {
    api_version: "v1", account_index: 2, logged_in: true, oauth: {},
    context: {
      client: { clientName: "WEB", clientVersion: "web-version", visitorData: "mock-visitor", hl: "en" },
      user: { onBehalfOfUser: "mock-selected-channel", enableSafetyMode: false },
      request: { useSsl: true },
    },
  };
  session.http = new HTTPClient(session, cookie, async (input, init) => {
    const outgoing = studioFetchInit(input, init, cookie);
    requests.push(new Request(input, outgoing));
    const response = new Response(JSON.stringify({ updated: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": "SAPISID=mock-refreshed; Path=/; Secure" },
    });
    // Emulate the existing youtubeFetch response-cookie update, not a new store.
    cookie = response.headers.getSetCookie()[0].split(";")[0] + "; marker=one";
    return response;
  });
  return { youtube: { session }, requests };
}

test("Studio request preserves arbitrary settings/context/read mask and selected delegation through real HTTPClient", async () => {
  const { youtube, requests } = fixture();
  const originalSession = structuredClone(youtube.session.context);
  const body = {
    channelId: "mock-owner-channel",
    exampleSettingsRequest: { values: ["one", "two"], enabled: false },
    anotherSettingsRequest: {},
    channelReadMask: { fields: ["example"] },
    context: {
      client: { clientVersion: "mock-studio-version", hl: "fr" },
      user: { onBehalfOfUser: "caller-cannot-change-selection" },
      request: { returnLogEntry: true },
      clickTracking: { clickTrackingParams: "mock-tracking" },
    },
  };
  const originalBody = structuredClone(body);
  assert.deepEqual(await updateCreatorChannel(youtube, body), { updated: true });
  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(url.origin, "https://studio.youtube.com");
  assert.equal(url.pathname, "/youtubei/v1/creator/update_creator_channel");
  assert.equal(url.searchParams.get("alt"), "json");
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  const sent = await request.json();
  assert.deepEqual(sent.exampleSettingsRequest, body.exampleSettingsRequest);
  assert.deepEqual(sent.anotherSettingsRequest, {});
  assert.deepEqual(sent.channelReadMask, body.channelReadMask);
  assert.equal(sent.channelId, body.channelId);
  assert.equal(sent.context.client.clientName, 62);
  assert.equal(sent.context.client.clientVersion, "mock-studio-version");
  assert.equal(sent.context.client.hl, "fr");
  assert.deepEqual(sent.context.request, body.context.request);
  assert.deepEqual(sent.context.clickTracking, body.context.clickTracking);
  assert.equal(sent.context.user.onBehalfOfUser, "mock-selected-channel");
  assert.equal(request.headers.get("X-Goog-Authuser"), "2");
  assert.equal(request.headers.get("X-Goog-PageId"), "mock-selected-channel");
  assert.equal(request.headers.get("X-Youtube-Client-Name"), "62");
  assert.equal(request.headers.get("X-Youtube-Client-Version"), "mock-studio-version");
  assert.equal(request.headers.get("Origin"), url.origin);
  assert.equal(request.headers.get("X-Origin"), url.origin);
  assert.equal(request.headers.get("Cookie"), "SAPISID=mock-initial; marker=one");
  const [timestamp, hash] = request.headers.get("Authorization").replace("SAPISIDHASH ", "").split("_");
  assert.equal(hash, createHash("sha1").update(`${timestamp} mock-initial ${url.origin}`).digest("hex"));
  assert.deepEqual(body, originalBody);
  assert.deepEqual(youtube.session.context, originalSession);
});

test("each Studio request signs the refreshed cookie, with defaults and no optional mask", async () => {
  const { youtube, requests } = fixture();
  delete youtube.session.context.user.onBehalfOfUser;
  await updateCreatorChannel(youtube, { channelId: "mock-owner" });
  await updateCreatorChannel(youtube, { channelId: "mock-owner", context: { user: { onBehalfOfUser: "ignored" } } });
  const sent = await requests[1].json();
  assert.equal(sent.context.client.clientVersion, Constants.CLIENTS.WEB_CREATOR.VERSION);
  assert.equal(sent.context.client.clientName, 62);
  assert.equal(sent.context.user.onBehalfOfUser, undefined);
  assert.equal(sent.channelReadMask, undefined);
  assert.equal(requests[1].headers.get("X-Goog-PageId"), null);
  assert.equal(requests[1].headers.get("Cookie"), "SAPISID=mock-refreshed; marker=one");
  const [timestamp, hash] = requests[1].headers.get("Authorization").replace("SAPISIDHASH ", "").split("_");
  assert.equal(hash, createHash("sha1").update(`${timestamp} mock-refreshed https://studio.youtube.com`).digest("hex"));
});

test("other requests retain their original fetch options and authentication", () => {
  const init = { headers: new Headers({ Authorization: "unchanged" }), body: "original", redirect: "follow" };
  for (const url of [
    "https://www.youtube.com/youtubei/v1/creator/update_creator_channel",
    "https://studio.youtube.com/youtubei/v1/browse",
  ]) assert.equal(studioFetchInit(new Request(url), init, ""), init);
});

test("missing owner/context/signing cookie fails before the mocked network send", async () => {
  const { youtube, requests } = fixture();
  for (const body of [{}, { channelId: "" }, { channelId: "mock-owner", context: [] }]) {
    await assert.rejects(updateCreatorChannel(youtube, body), TypeError);
  }
  assert.equal(requests.length, 0);
  assert.throws(() => studioFetchInit(
    new Request("https://studio.youtube.com/youtubei/v1/creator/update_creator_channel"),
    { body: "{}" }, "marker=one",
  ), /SAPISID/);
});

test("HTTP errors and rejected fetches propagate from the existing HTTPClient", async () => {
  const { youtube } = fixture();
  youtube.session.http = new HTTPClient(youtube.session, "", async () => new Response("denied", { status: 403 }));
  await assert.rejects(updateCreatorChannel(youtube, { channelId: "mock-owner" }), /status code 403/);
  youtube.session.http = new HTTPClient(youtube.session, "", async () => { throw new Error("mock-network-error"); });
  await assert.rejects(updateCreatorChannel(youtube, { channelId: "mock-owner" }), /mock-network-error/);
});

test("worker RPC uses the Studio adapter and persists refreshed cookies with delegation", { timeout: 10000 }, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "studio-mock-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cookieFile = path.join(scratch, "cookie.json");
  await writeFile(cookieFile, JSON.stringify({
    cookie: "SAPISID=mock-initial", account_index: 2, on_behalf_of_user: "mock-selected-channel",
  }));
  const preload = path.join(scratch, "preload.mjs");
  const library = new URL("node_modules/youtubei.js/dist/src/platform/node.js", import.meta.url).href;
  await writeFile(preload, `
import { Innertube, HTTPClient } from ${JSON.stringify(library)};
Innertube.create = async (options) => {
  const session = {
    api_version: "v1", account_index: options.account_index, logged_in: true, oauth: {},
    context: {
      client: { clientName: "WEB", clientVersion: "mock-web-version" },
      user: { onBehalfOfUser: options.on_behalf_of_user },
    },
  };
  session.http = new HTTPClient(session, options.cookie, options.fetch);
  return { session, account: { getInfo: async () => [{ is_selected: true, account_name: "Mock" }] } };
};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://studio.youtube.com" || url.pathname !== "/youtubei/v1/creator/update_creator_channel") {
    throw new Error("Mock forbids all other network requests");
  }
  return new Response(JSON.stringify({ body: await request.json(), headers: Object.fromEntries(request.headers) }), {
    headers: { "Set-Cookie": "SAPISID=mock-refreshed; Path=/; Secure" },
  });
};
`);
  const worker = spawn(process.execPath, ["--import", preload, new URL("worker.mjs", import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: "", YT_STREAM_MODBOT_COOKIE_FILE: cookieFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (worker.exitCode === null) worker.kill(); });
  let stderr = "";
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: worker.stdout });
  t.after(() => lines.close());
  const frames = lines[Symbol.asyncIterator]();
  async function frame(type, id) {
    for (;;) {
      const next = await frames.next();
      assert.equal(next.done, false, stderr);
      const value = JSON.parse(next.value);
      if (value.type === type && (id === undefined || value.id === id)) return value;
    }
  }
  const ready = await frame("ready");
  assert.equal(ready.authentication.status, "authenticated");
  await frame("hello");
  worker.stdin.write(JSON.stringify({ type: "hello", protocol: 1, name: "test" }) + "\n");
  for (const id of ["first", "second"]) {
    worker.stdin.write(JSON.stringify({
      type: "call", id, name: "innertube", method: "request",
      args: ["update_creator_channel", { channelId: "mock-owner", exampleSettingsRequest: { enabled: true } }], kwargs: {},
    }) + "\n");
    const reply = (await frame("result", id)).value;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.body.channelId, "mock-owner");
    assert.deepEqual(reply.result.body.exampleSettingsRequest, { enabled: true });
    assert.equal(reply.result.headers["x-youtube-client-name"], "62");
    assert.equal(reply.result.headers["x-goog-authuser"], "2");
    assert.equal(reply.result.headers["x-goog-pageid"], "mock-selected-channel");
    assert.equal(reply.result.headers.cookie, id === "first" ? "SAPISID=mock-initial" : "SAPISID=mock-refreshed");
  }
  const saved = JSON.parse(await readFile(cookieFile, "utf8"));
  assert.deepEqual(saved, { cookie: "SAPISID=mock-refreshed", account_index: 2, on_behalf_of_user: "mock-selected-channel" });
  worker.stdin.end();
  const exit = await new Promise((resolve) => worker.once("exit", resolve));
  assert.equal(exit, 0, stderr);
});
