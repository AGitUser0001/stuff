"""Small Python client for the standalone InnerTube worker (Python 3.12+)."""

import argparse
import asyncio
import contextlib
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Self

from cordis_py import Bridge

WORKER = Path(__file__).with_name("worker.mjs")


class InnerTubeError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class InnerTube:
    def __init__(self, node: str = "node") -> None:
        self.node = node
        self.process: asyncio.subprocess.Process | None = None
        self.bridge: Bridge | None = None
        self.subscriptions: dict[str, str] = {}

    async def __aenter__(self) -> Self:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def start(self) -> None:
        if self.process is not None:
            return
        self.process = await asyncio.create_subprocess_exec(
            self.node, str(WORKER), cwd=WORKER.parent,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        )
        try:
            assert self.process.stdout is not None
            line = await asyncio.wait_for(self.process.stdout.readline(), 30)
            if not line:
                raise InnerTubeError("WORKER_EXITED", "worker exited before becoming ready")
            ready = json.loads(line)
            if ready.get("type") != "ready" or ready.get("protocol") != 1:
                raise InnerTubeError("PROTOCOL_ERROR", "unexpected worker startup response")
            assert self.process.stdin is not None
            self.bridge = Bridge("innertube-python")
            self.bridge._adopt(self.process.stdout, self.process.stdin)
            async def wait_for_hello() -> None:
                assert self.bridge is not None
                while self.bridge.peer is None:
                    if self.bridge.closed or self.process is None or self.process.returncode is not None:
                        raise InnerTubeError("WORKER_DISCONNECTED", "Bridge handshake failed")
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(wait_for_hello(), 5)
        except BaseException:
            await self.close()
            raise

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        await self.start()
        assert self.bridge is not None
        response = await self.bridge.proxy("innertube").request(method, params or {})
        if not isinstance(response, dict):
            raise InnerTubeError("PROTOCOL_ERROR", "invalid worker response")
        if response.get("ok") is not True:
            error = response.get("error")
            if not isinstance(error, dict):
                error = {}
            raise InnerTubeError(str(error.get("code", "INNERTUBE_ERROR")), str(error.get("message", "request failed")))
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    def on_event(self, callback):
        """Receive worker events such as message, pinned, and subscription_end."""
        if self.bridge is None:
            raise InnerTubeError("WORKER_UNAVAILABLE", "start the worker before registering events")
        return self.bridge.on_event("innertube/event", callback)

    async def subscribe(self, video_id: str) -> str:
        if video_id in self.subscriptions:
            return self.subscriptions[video_id]
        subscription_id = f"python-{uuid.uuid4()}"
        await self.request("subscribe", {"video_id": video_id, "subscription_id": subscription_id})
        self.subscriptions[video_id] = subscription_id
        return subscription_id

    async def login(self) -> dict[str, Any]:
        """Open the dedicated Chrome window and save the selected account locally."""
        return await self.request("login", {})

    async def send_message(self, video_id: str, text: str) -> str:
        await self.subscribe(video_id)
        result = await self.request("send_message", {"video_id": video_id, "text": text})
        message_id = result.get("message_id")
        if not isinstance(message_id, str) or not message_id:
            raise InnerTubeError("PROTOCOL_ERROR", "YouTube did not return a message ID")
        return message_id

    async def close(self) -> None:
        if self.bridge is not None:
            await self.bridge.close()
            self.bridge = None
        process, self.process = self.process, None
        self.subscriptions.clear()
        if process is None:
            return
        if process.stdin is not None:
            process.stdin.close()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                await process.stdin.wait_closed()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            process.kill()
            await process.wait()


async def _send_once(node: str, video_id: str, text: str) -> str:
    async with InnerTube(node) as client:
        return await client.send_message(video_id, text)


async def _login(node: str) -> dict[str, Any]:
    async with InnerTube(node) as client:
        return await client.login()


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a YouTube live-chat message through the InnerTube worker")
    parser.add_argument("video_id", nargs="?", help="live video ID, not its full URL")
    parser.add_argument("text", nargs="?", help="message to send")
    parser.add_argument("--login", action="store_true", help="open Chrome login and save credentials locally")
    parser.add_argument("--node", default="node", help="Node.js executable (default: node on PATH)")
    args = parser.parse_args()
    if args.login:
        if args.video_id or args.text:
            parser.error("--login does not take a video ID or message")
        try:
            identity = asyncio.run(_login(args.node))
        except (InnerTubeError, OSError, TimeoutError) as error:
            print(error, file=sys.stderr)
            return 1
        print(f"Logged in as {identity.get('channel_handle') or identity.get('account_name') or 'the selected YouTube account'}")
        return 0
    if not args.video_id or not args.text:
        parser.error("provide VIDEO_ID and MESSAGE, or use --login")
    try:
        print(asyncio.run(_send_once(args.node, args.video_id, args.text)))
    except (InnerTubeError, OSError, TimeoutError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
