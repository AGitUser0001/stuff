# InnerTube live-chat worker

This is a standalone copy of the bot's InnerTube worker. It uses `youtubei.js` and exchanges newline-delimited JSON over stdin/stdout. `bridge.py` handles that protocol for Python callers; `worker.mjs --login` can also be run directly.

## Log in

Install Node.js 22.15 or newer, Python 3.12 or newer, and Google Chrome. Run these commands from this directory. On Windows 10 21H2 LTSC, use PowerShell:

```powershell
npm ci
py -3.12 -m pip install -r requirements.txt
py -3.12 .\bridge.py --login
```

On macOS, install Google Chrome in `/Applications` or `~/Applications`, then use Terminal:

```sh
npm ci
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python bridge.py --login
```

On Linux, install Google Chrome so `google-chrome` or `google-chrome-stable` is on `PATH`, then use a terminal:

```sh
npm ci
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python bridge.py --login
```

Sign in to YouTube, select the channel or Brand Account you want to post as, then close that Chrome window. The command creates `secrets/youtube_cookie.txt` and `secrets/innertube_chrome_profile/` beside this README, verifies authentication, and exits. These are private credentials; do not share or commit them. You can also run `node worker.mjs --login` directly.

If Chrome is installed elsewhere, set `YT_STREAM_MODBOT_CHROME_COMMAND` to its executable path (PowerShell: `$env:YT_STREAM_MODBOT_CHROME_COMMAND = 'C:\path\to\chrome.exe'`; macOS/Linux: `export YT_STREAM_MODBOT_CHROME_COMMAND=/path/to/google-chrome`). `YT_STREAM_MODBOT_COOKIE_FILE` and `YT_STREAM_MODBOT_CHROME_PROFILE_DIR` can override the local defaults.

## Send a chat message

The worker reuses the local cookie file created above. You can instead set `YT_STREAM_MODBOT_COOKIE_FILE` to a private file containing a manually copied YouTube `Cookie` request header. The worker may update it when YouTube refreshes cookies. Use the `video_id` from the live video's URL, not the full URL. To send one real message on Windows:

```powershell
py -3.12 .\bridge.py VIDEO_ID "Hello, chat!"
```

On macOS or Linux, send with `./.venv/bin/python bridge.py VIDEO_ID "Hello, chat!"`. For a longer-running Python program, the wrapper starts and stops the worker for you:

```python
import asyncio
from bridge import InnerTube

async def main():
    async with InnerTube() as chat:
        message_id = await chat.send_message("VIDEO_ID", "Hello, chat!")
        print(message_id)

asyncio.run(main())
```

`send_message` subscribes to the video automatically. The Python API also supports `await chat.login()` to open the Chrome login flow, `await chat.request("identity", {})` for account state, `await chat.subscribe(video_id)`, and `chat.on_event(callback)` after entering the context. The rest of the worker methods are listed below.

## Raw protocol

If you do not want the Python wrapper, start the worker and send JSON lines yourself:

```powershell
node .\worker.mjs
```

Wait for its `ready` line. Then send these JSON lines to stdin, in order, replacing the video ID and message text:

```jsonl
{"type":"hello","protocol":1,"name":"example"}
{"type":"call","id":"1","name":"innertube","method":"request","args":["subscribe",{"video_id":"VIDEO_ID","subscription_id":"chat"}],"kwargs":{}}
{"type":"call","id":"2","name":"innertube","method":"request","args":["send_message",{"video_id":"VIDEO_ID","text":"Hello, chat!"}],"kwargs":{}}
```

Wait for the `id:"1"` result before sending the message. A successful send returns `{"type":"result","id":"2","value":{"ok":true,"result":{"message_id":"..."}}}`. An operation failure is also a `result` frame, but its `value` has `ok:false` and an `error` object. Bridge-level errors use `type:"error"`. `send_message` requires an authenticated account and a subscription to that video. It posts a real message; it is not a dry run.

Stop the subscription with `unsubscribe` and `{"subscription_id":"chat"}`, or close stdin to stop the worker. The worker emits live updates as `innertube/event` frames while subscribed.

## Other requests

All calls use the same `innertube.request(method, params)` envelope shown above:

| Method | Main parameters | Purpose |
| --- | --- | --- |
| `ping`, `identity` | `identity` optionally takes `video_id` | Authentication and account/moderator state |
| `discover` | `target` | Find a live stream from a handle or channel |
| `inspect_stream` | `video_id` | Get stream and owner details |
| `subscribe`, `unsubscribe` | `video_id`, `subscription_id`; or `subscription_id` | Start/stop live-chat updates |
| `resolve_user` | `target` (`@handle` or channel ID) | Resolve a channel |
| `delete`, `resolve_held` | `message_id`; held resolution also needs `video_id`, `allow` | Remove/review messages |
| `inspect_user_visibility` | `video_id`, `author_channel_id`; optional `message_id` | Check whether a user is hidden |
| `timeout`, `hide`, `unhide` | `video_id`, `author_channel_id`; timeout also needs `seconds` | Moderate a user |
| `login` | none | Open the dedicated Chrome login; also available as `node worker.mjs --login` |

These are YouTube operations, not local simulations. The wire contract is implemented in `dispatch()` in `worker.mjs` and `CordisBridge` in `cordis_bridge.mjs`.

## Unhide users after future live-chat hide events

This example watches future author-wide moderation actions and immediately
unhides the affected user if YouTube confirms that they are hidden. It does not
list or unhide historical hidden users. Sign in as the stream owner or an account
with the required moderation permission before running it; `unhide` is a real
channel-wide moderation operation.

The text-only `moderation` event has no affected-user channel ID. Enable the
existing `trace_action` event instead. The installed parsers expose
`MarkChatItemsByAuthorAsDeletedAction` and `RemoveChatItemByAuthorAction` with
`external_channel_id`, the affected user. A moderator's linked channel ID in
`deleted_state_message` identifies the actor and must not be used as the target.
These author-wide actions can also accompany timeouts, so check the existing
`inspect_user_visibility` API before requesting `unhide`; do not infer a hide
from localized text such as “this user was hidden by…”.

```python
import asyncio
import os
import re
from bridge import InnerTube, InnerTubeError

async def unhide_future_hides(chat, video_id):
    pending = asyncio.Queue()

    def receive(event):
        if (not isinstance(event, dict) or event.get("event") != "trace_action"
                or event.get("video_id") != video_id
                or event.get("historical") is not False):
            return
        action = event.get("action")
        if not isinstance(action, dict) or action.get("type") not in {
            "MarkChatItemsByAuthorAsDeletedAction", "RemoveChatItemByAuthorAction",
        }:
            return
        affected = action.get("external_channel_id")
        if isinstance(affected, str) and re.fullmatch(r"UC[\w-]{22}", affected, re.ASCII):
            pending.put_nowait(affected)

    remove_listener = chat.on_event(receive)
    try:
        await chat.subscribe(video_id)
        while True:
            affected = await pending.get()
            visibility = await chat.request("inspect_user_visibility", {
                "video_id": video_id, "author_channel_id": affected,
            })
            if visibility.get("hidden") is not True:
                continue
            try:
                await chat.request("unhide", {
                    "video_id": video_id, "author_channel_id": affected,
                })
            except InnerTubeError as error:
                # Another moderator may have unhidden the user in the meantime.
                if error.code != "NOT_HIDDEN":
                    raise
    finally:
        remove_listener()

async def main():
    os.environ["YT_STREAM_MODBOT_TRACE_EVENTS"] = "1"  # Set before worker startup.
    async with InnerTube() as chat:
        await unhide_future_hides(chat, "VIDEO_ID")

asyncio.run(main())
```

Initial snapshot actions (`historical: true`) are skipped. Requests are processed
in event order, and repeated actions are checked against current visibility.
Single-message deletions, held-message rejection, and text-only notices are
ignored. A lost subscription or an unavailable visibility/unhide action can
prevent handling an event; this is an event-driven example, not a historical
reconciliation job. Stop it with Ctrl+C.
