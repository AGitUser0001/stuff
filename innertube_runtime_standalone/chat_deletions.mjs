import { randomUUID } from "node:crypto";

/** Preserve an action's event time, never the deleted message's posting time.
 * @param {any} data @returns {string | undefined} */
export function deletionTimestamp(data) {
  const usec = data?.timestampUsec;
  const ms = data?.timestampMs;
  const value = usec != null ? Number(usec) / 1000 : ms != null ? Number(ms) : NaN;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Convert YouTube removal actions without replacing the original chat text.
 * @param {any} action
 * @param {string} videoId
 */
export function chatDeletion(action, videoId) {
  const markedSingle = action?.type === "MarkChatItemAsDeletedAction";
  const markedAuthor = action?.type === "MarkChatItemsByAuthorAsDeletedAction";
  const single = markedSingle || action?.type === "RemoveChatItemAction";
  const author = markedAuthor || action?.type === "RemoveChatItemByAuthorAction";
  const byModerator = author;
  if (!single && !author) return null;
  const messageId = single ? action.target_item_id : null;
  const channelId = author ? action.external_channel_id : null;
  if (!messageId && !channelId) return null;
  const state = action.deleted_state_message;
  // YouTube's author-wide actions are moderation. Single-item mark/remove
  // actions are ordinary removal/retraction/redaction and must not be
  // reclassified from localized display text or an incidental channel run.
  const actor = byModerator && state?.runs?.findLast((/** @type {any} */ run) =>
    /^UC[\w-]{22}$/.test(run.endpoint?.payload?.browseId || "") || /^@\S+$/.test(run.text || ""),
  );
  return {
    id: randomUUID(),
    live_chat_id: videoId,
    message_id: messageId || null,
    author_channel_id: channelId || null,
    timestamp: action.event_timestamp || deletionTimestamp(action) || new Date().toISOString(),
    actor_channel_id: actor?.endpoint?.payload?.browseId || null,
    actor_name: actor?.text || null,
    reason: null,
    by_moderator: byModerator,
  };
}
