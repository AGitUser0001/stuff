import assert from "node:assert/strict";
import test from "node:test";

import { ChatItems, responseActions } from "./chat_items.mjs";

test("responseActions aggregates every supported response container", () => {
  const command = { kind: "command" };
  const action = { kind: "action" };
  const clientAction = { kind: "client" };
  const responseAction = { kind: "response" };

  assert.deepEqual(responseActions({
    command,
    action,
    clientActions: [clientAction, command],
    onResponseReceivedActions: [responseAction],
  }), [command, action, clientAction, responseAction]);
});

test("responseActions accepts singular containers and empty responses", () => {
  const update = { kind: "update" };
  assert.deepEqual(responseActions({ updateFlowCommand: update }), [update]);
  assert.deepEqual(responseActions(null), []);
});

test("a successful Hide cannot be mistaken for the returned unwrap replacement", () => {
  const items = new ChatItems("video", 10);
  items.apply({
    type: "AddChatItemAction",
    item: {
      type: "LiveChatAutoModMessage",
      id: "held-row",
      auto_moderated_item: { id: "message", message: { runs: [] } },
    },
  });

  items.resolveReview("message", "hidden");
  const [{ entry }] = items.apply({
    type: "ReplaceChatItemAction",
    target_item_id: "held-row",
    replacement_item: {
      type: "LiveChatTextMessage",
      id: "message",
      message: { runs: [] },
    },
  });

  assert.equal(entry.reviewState, "hidden");
});
