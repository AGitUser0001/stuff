import assert from "node:assert/strict";
import test from "node:test";

import { chatDeletion } from "./chat_deletions.mjs";

const videoId = "video";

test("Single-item mark actions are ordinary removals", () => {
  const deletion = chatDeletion({
    type: "MarkChatItemAsDeletedAction",
    target_item_id: "message",
    deleted_state_message: {
      text: "localized provider text",
      runs: [{
        text: "@moderator",
        endpoint: { payload: { browseId: "UC1234567890123456789012" } },
      }],
    },
  }, videoId);

  assert.equal(deletion?.by_moderator, false);
  assert.equal(deletion?.actor_name, null);
});

test("Remove actions stay ordinary removals regardless of display text", () => {
  const deletion = chatDeletion({
    type: "RemoveChatItemAction",
    target_item_id: "message",
    deleted_state_message: {
      text: "Removed by @moderator",
      runs: [{
        text: "@moderator",
        endpoint: { payload: { browseId: "UC1234567890123456789012" } },
      }],
    },
  }, videoId);

  assert.equal(deletion?.by_moderator, false);
  assert.equal(deletion?.actor_name, null);
  assert.equal(deletion?.actor_channel_id, null);
});

test("Replacement items are not deletion signals", () => {
  const deletion = chatDeletion({
    type: "ReplaceChatItemAction",
    target_item_id: "message",
    replacement_item: {
      id: "replacement",
      deleted_state_message: { text: "localized provider text", runs: [] },
    },
  }, videoId);

  assert.equal(deletion, null);
});

test("Remove-by-author actions are moderator removals", () => {
  const deletion = chatDeletion({
    type: "RemoveChatItemByAuthorAction",
    external_channel_id: "author",
  }, videoId);

  assert.equal(deletion?.by_moderator, true);
});

test("Mark-by-author actions are moderator removals", () => {
  const deletion = chatDeletion({
    type: "MarkChatItemsByAuthorAsDeletedAction",
    external_channel_id: "author",
    deleted_state_message: {
      runs: [{
        text: "@moderator",
        endpoint: { payload: { browseId: "UC1234567890123456789012" } },
      }],
    },
  }, videoId);

  assert.equal(deletion?.by_moderator, true);
  assert.equal(deletion?.actor_name, "@moderator");
});
