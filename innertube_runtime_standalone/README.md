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
| `update_creator_channel` | Studio request body including owner `channelId`; settings request objects, optional `context` and `channelReadMask` | Update creator channel settings through YouTube Studio |

These are YouTube operations, not local simulations. The wire contract is implemented in `dispatch()` in `worker.mjs` and `CordisBridge` in `cordis_bridge.mjs`.

## General Studio channel settings

`await chat.update_creator_channel(body)` (or
`await chat.request("update_creator_channel", body)`) posts the supplied settings
to Studio's `creator/update_creator_channel` endpoint. `channelId` is the owner
channel being updated. Settings request objects and the optional `channelReadMask`
pass through without interpretation. The worker supplies Studio client ID 62,
using YouTube.js's `WEB_CREATOR` version by default; `context.client.clientVersion`
can override it. Other context fields can be supplied per request. Account index
and channel delegation remain those of the selected authenticated session.

For example, to remove **all IDs in a known, complete hidden-user list**, supply
that list in `commentsSettingsRequest.removedHiddenUsers`:

```python
async with InnerTube() as chat:
    await chat.update_creator_channel({
        "channelId": "OWNER_CHANNEL_ID",
        "commentsSettingsRequest": {
            "removedHiddenUsers": ["KNOWN_HIDDEN_CHANNEL_ID_1", "KNOWN_HIDDEN_CHANNEL_ID_2"],
        },
    })
```

Replace the placeholders with your owner channel and every known hidden-user ID
you intend to remove. This API does not enumerate hidden users. An empty array
does not mean “clear everyone”; only explicitly supplied IDs are requested for
removal. This is a real settings update and requires owner-authorized Studio
access; being a live-chat moderator alone does not grant it.
