"""One process, one unmodified Python script. The bridge owns its lifetime."""

import json
import os
import random
import runpy
import sys
import traceback


def main() -> int:
    script, seed, descriptor, frame_limit = sys.argv[1:]
    fd, limit = int(descriptor), int(frame_limit)

    # Only this process writes structured display/lifecycle messages. Ordinary
    # stdout/stderr are separate pipes and can never become bridge control frames.
    def emit(kind, **data):
        frame = (json.dumps({"type": kind, **data}) + "\n").encode()
        if len(frame) > limit:
            raise ValueError("script display exceeds frame limit")
        view = memoryview(frame)
        while view:
            view = view[os.write(fd, view) :]

    try:
        import matplotlib
        import numpy as np
        from IPython.core.displaypub import DisplayPublisher
        from IPython.core.interactiveshell import InteractiveShell

        matplotlib.use("Agg")
        random.seed(int(seed))
        np.random.seed(int(seed) % 2**32)

        class Publisher(DisplayPublisher):
            def publish(self, data, metadata=None, **kwargs):
                if kwargs.get("update"):
                    raise ValueError("script display updates are unsupported")
                selected = {}
                for mime in ("text/plain", "text/html", "image/png"):
                    if mime in data:
                        value = data[mime]
                        if not isinstance(value, str):
                            raise ValueError("display must contain strings")
                        selected[mime] = value
                emit(
                    "display",
                    output={
                        "output_type": "display_data",
                        "data": selected,
                        "metadata": {},
                    },
                )

        # This shell only supplies explicit display(), never evaluates user code
        # and dies with this process. No notebook expression transformation occurs.
        InteractiveShell.instance().display_pub = Publisher()
        emit("started", pid=os.getpid())
        runpy.run_path(script, run_name="__main__")
        emit("complete", status="ok")
        return 0
    except BaseException as exc:
        error = {
            "ename": type(exc).__name__,
            "evalue": str(exc),
            "traceback": traceback.format_exception(exc),
        }
        try:
            emit("complete", status="error", error=error)
        except (OSError, ValueError):
            traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
