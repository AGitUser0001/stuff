"""Execute the README orchestration with mocked events and moderation requests."""

import asyncio
import contextlib
from pathlib import Path
import unittest

from bridge import InnerTubeError


TARGET = "UC" + "a" * 22
MODERATOR = "UC" + "b" * 22


def action_event(kind="MarkChatItemsByAuthorAsDeletedAction", **overrides):
    return {
        "event": "trace_action", "video_id": "video", "historical": False,
        "action": {
            "type": kind, "external_channel_id": TARGET,
            "deleted_state_message": {
                "text": "localized moderation text",
                "runs": [{"endpoint": {"payload": {"browseId": MODERATOR}}}],
            },
        },
        **overrides,
    }


class FakeChat:
    def __init__(self, events, hidden=True, unhide_error=None):
        self.events = events
        self.hidden = hidden
        self.unhide_error = unhide_error
        self.calls = []
        self.started = asyncio.Event()
        self.handled = asyncio.Event()
        self.listener = None
        self.disposed = False

    def on_event(self, callback):
        self.listener = callback
        return lambda: setattr(self, "disposed", True)

    async def subscribe(self, video_id):
        assert video_id == "video"
        for event in self.events:
            self.listener(event)
        self.started.set()

    async def request(self, method, params):
        self.calls.append((method, params))
        if method == "inspect_user_visibility":
            if self.hidden is not True:
                self.handled.set()
            return {"hidden": self.hidden}
        assert method == "unhide"
        self.handled.set()
        if self.unhide_error:
            raise self.unhide_error
        return {"success": True}


class LiveChatExampleTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        readme = Path(__file__).with_name("README.md").read_text()
        section = readme.split("## Unhide users after future live-chat hide events", 1)[1]
        snippet = section.split("```python\n", 1)[1].split("\n```", 1)[0]
        namespace = {"__name__": "readme_example"}
        # Execute the exact definitions, keeping the live entry point inactive.
        exec(snippet.rsplit("\nasyncio.run(main())", 1)[0], namespace)
        cls.watch = staticmethod(namespace["unhide_future_hides"])

    async def run_example(self, chat, *, handled=True):
        task = asyncio.create_task(self.watch(chat, "video"))
        try:
            await asyncio.wait_for(chat.started.wait(), 1)
            if handled:
                await asyncio.wait_for(chat.handled.wait(), 1)
            else:
                await asyncio.sleep(0)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.assertTrue(chat.disposed)

    async def test_author_wide_actions_target_affected_user_not_moderator(self):
        for kind in ("MarkChatItemsByAuthorAsDeletedAction", "RemoveChatItemByAuthorAction"):
            with self.subTest(kind=kind):
                chat = FakeChat([action_event(kind)])
                await self.run_example(chat)
                target = {"video_id": "video", "author_channel_id": TARGET}
                self.assertEqual(chat.calls, [
                    ("inspect_user_visibility", target), ("unhide", target),
                ])

    async def test_history_other_stream_and_non_author_actions_are_ignored(self):
        events = [
            action_event(historical=True), action_event(video_id="other"),
            action_event("MarkChatItemAsDeletedAction"),
            action_event("RemoveChatItemAction"),
            {"event": "moderation", "message": {"text": "This user was hidden by…"}},
            action_event(action={"type": "MarkChatItemsByAuthorAsDeletedAction"}),
            action_event(action={"type": "RemoveChatItemByAuthorAction", "external_channel_id": "invalid"}),
            action_event(historical=None), action_event(action=None), None,
        ]
        chat = FakeChat(events)
        await self.run_example(chat, handled=False)
        self.assertEqual(chat.calls, [])

    async def test_timeouts_and_unknown_visibility_do_not_unhide(self):
        for hidden in (False, None, "true"):
            with self.subTest(hidden=hidden):
                chat = FakeChat([action_event()], hidden=hidden)
                await self.run_example(chat)
                self.assertEqual([method for method, _ in chat.calls], ["inspect_user_visibility"])

    async def test_unhide_race_is_tolerated(self):
        chat = FakeChat([action_event()], unhide_error=InnerTubeError("NOT_HIDDEN", "already visible"))
        await self.run_example(chat)
        self.assertEqual(len(chat.calls), 2)

    async def test_other_failures_are_reported_and_listener_removed(self):
        chat = FakeChat([action_event()], unhide_error=InnerTubeError("ACTION_NOT_AVAILABLE", "no action"))
        with self.assertRaises(InnerTubeError) as raised:
            await self.run_example(chat)
        self.assertEqual(raised.exception.code, "ACTION_NOT_AVAILABLE")
        self.assertTrue(chat.disposed)


if __name__ == "__main__":
    unittest.main()
