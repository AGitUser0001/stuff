import { chatDeletion } from "./chat_deletions.mjs";
import { randomUUID } from "node:crypto";

/** YouTube's service-response action selection (ywa in the traced client).
 * @param {any} data @returns {any[]}
 */
export function responseActions(data) {
  if (!data) return [];
  /** @type {any[]} */
  const result = [];
  /** @type {Set<any>} */
  const seen = new Set();
  /** @param {any} value */
  const append = (value) => {
    for (const action of Array.isArray(value) ? value : value ? [value] : []) {
      if (!action || seen.has(action)) continue;
      seen.add(action);
      result.push(action);
    }
  };
  append(data.command);
  append(data.onExecutionAction);
  append(data.onResponseReceivedCommand);
  append(data.updateFlowCommand);
  append(data.action);
  append(data.clientActions);
  append(data.actions);
  append(data.commands);
  append(data.onResponseReceivedActions);
  append(data.onResponseReceivedCommands);
  append(data.onResponseReceivedEndpoints);
  return result;
}

/** @typedef {{ key: string, item: any, wasHeld: boolean, reviewState: 'shown' | 'hidden' | null, removal: any, original: any }} ChatItem */

/** The item-list operations used by YouTube's live chat client.
 * Unlike message IDs, row keys survive replacement and distinguish renderer types.
 * Removed text is retained for our moderation console, not redacted like YouTube.
 */
export class ChatItems {
  /** @type {ChatItem[]} */
  items = [];

  /** @param {string} videoId @param {number} limit */
  constructor(videoId, limit) {
    this.videoId = videoId;
    this.limit = limit;
  }

  /** Record the outcome before applying YouTube's returned replacement/removal
   * actions. A Hide response can contain an unwrapped replacement followed by
   * a deletion; without this, the replacement is momentarily mistaken for a
   * successful Show and that state becomes latched.
   * @param {string} messageId @param {'shown' | 'hidden'} state
   */
  resolveReview(messageId, state) {
    for (const entry of this.items) {
      const item = entry.item;
      const inner = item?.auto_moderated_item;
      if (item?.id === messageId || inner?.id === messageId || entry.original?.id === messageId) {
        entry.wasHeld = true;
        entry.reviewState = state;
      }
    }
  }

  /** @param {any} action @returns {{ entry: ChatItem, added: boolean }[]} */
  apply(action) {
    const type = action?.type;
    if (type === "AddChatItemAction" || type === "ReplaceChatItemAction") {
      const item = type === "AddChatItemAction" ? action.item : action.replacement_item;
      if (!item?.id) return [];
      const matches = this.items.filter(({ item: previous }) => type === "ReplaceChatItemAction"
        ? previous.id === action.target_item_id
        : previous.type === item.type && (previous.id === item.id || previous.id === action.client_id));
      if (!matches.length && type === "ReplaceChatItemAction") return [];
      const added = !matches.length;
      if (added) {
        const baseKey = `${item.type}:${item.id}`;
        const key = this.items.some(entry => entry.key === baseKey) ? `${baseKey}:${randomUUID()}` : baseKey;
        const entry = { key, item, wasHeld: false, reviewState: null, removal: null, original: null };
        this.items.push(entry);
        this.items = this.items.slice(-this.limit);
        matches.push(entry);
      }
      return matches.map(entry => {
        entry.item = item;
        entry.wasHeld ||= Boolean(item.auto_moderated_item);
        const content = item.auto_moderated_item || item;
        if (content.message) entry.original = content;
        // Replacement overwrites deleted state, rather than permanently latching it.
        entry.removal = chatDeletion(action, this.videoId);
        if (!item.auto_moderated_item && entry.wasHeld && !entry.reviewState) {
          if (entry.removal) entry.reviewState = 'hidden';
          else if (content.message) entry.reviewState = 'shown';
        }
        return { entry, added };
      });
    }
    const byId = ["MarkChatItemAsDeletedAction", "RemoveChatItemAction"].includes(type);
    const byAuthor = ["MarkChatItemsByAuthorAsDeletedAction", "RemoveChatItemByAuthorAction"].includes(type);
    if (!byId && !byAuthor) return [];
    const remove = type.startsWith("Remove");
    /** @type {{ entry: ChatItem, added: boolean }[]} */
    const changes = [];
    this.items.forEach((entry, index) => {
      const item = entry.item;
      const matches = byId ? item.id === action.target_item_id
        : (item.author?.id || item.author_external_channel_id) === action.external_channel_id;
      if (!matches) return;
      // The client splices ID removals during forEach, but filters author removals.
      if (remove && byId) this.items.splice(index, 1);
      else if (!remove) {
        // YouTube unwraps an AutoMod item before marking its inner text deleted.
        entry.item = entry.item.auto_moderated_item || entry.item;
        entry.item.deleted_state_message = action.deleted_state_message;
      }
      entry.removal = remove || action.deleted_state_message ? chatDeletion(action, this.videoId) : null;
      if (entry.wasHeld && !entry.reviewState && entry.removal) entry.reviewState = 'hidden';
      changes.push({ entry, added: false });
    });
    if (remove && byAuthor) {
      const removed = new Set(changes.map(change => change.entry));
      this.items = this.items.filter(entry => !removed.has(entry));
    }
    return changes;
  }
}
