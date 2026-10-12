import asyncio
from queue import Empty

from statigent_runtime.bridge import Bridge


def test_reply_alone_cannot_finish_before_idle_and_last_output(tmp_path):
    class Client:
        def __init__(self):
            self.messages = iter(
                [
                    ("stream", {"name": "stdout", "text": "first"}),
                    ("status", {"execution_state": "busy"}),
                    ("stream", {"name": "stdout", "text": "last"}),
                    ("status", {"execution_state": "idle"}),
                ]
            )
            self.reply_sent = False

        def execute(self, *_args, **_kwargs):
            return "kernel-request"

        async def get_iopub_msg(self, **_kwargs):
            kind, content = next(self.messages)
            return {
                "msg_type": kind,
                "content": content,
                "parent_header": {"msg_id": "kernel-request"},
            }

        async def get_shell_msg(self, **_kwargs):
            if self.reply_sent:
                raise Empty
            self.reply_sent = True
            return {
                "msg_type": "execute_reply",
                "content": {"status": "ok"},
                "parent_header": {"msg_id": "kernel-request"},
            }

    class Manager:
        async def is_alive(self):
            return True

    bridge = Bridge(tmp_path)
    bridge.client = Client()
    bridge.manager = Manager()
    bridge.available = True
    bridge.limits = {
        "max_frame_bytes": 4096,
        "max_output_bytes": 8192,
        "max_artifact_bytes": 8192,
        "max_artifacts_bytes": 8192,
    }
    events = []
    bridge.emit = lambda _request, kind, **data: events.append({"type": kind, **data})
    asyncio.run(
        bridge.execute(
            {
                "type": "execute",
                "request_id": "r1",
                "cell_id": "c1",
                "kernel_epoch": 1,
                "execution_seq": 1,
                "code": "print('x')",
            }
        )
    )
    assert [event["type"] for event in events] == ["output", "output", "result"]
    assert events[1]["output"]["text"] == "last"
    assert events[-1]["status"] == "ok"
