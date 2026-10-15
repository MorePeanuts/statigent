"""导入上游类型时禁用默认凭据和客户端；真实请求必须通过宿主桥接。"""

from contextlib import contextmanager


class DisabledClient:
    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        raise RuntimeError("Upstream direct model client disabled; use host bridge")


@contextmanager
def upstream_import_boundary():
    import dotenv
    import openai

    original = (openai.Client, openai.AsyncClient, dotenv.load_dotenv)
    # DatawiseAgent 在模块导入期间创建这两个全局客户端；拒绝直接 SDK 通道。
    openai.Client = DisabledClient
    openai.AsyncClient = DisabledClient
    dotenv.load_dotenv = lambda *args, **kwargs: False
    try:
        yield
    finally:
        openai.Client, openai.AsyncClient, dotenv.load_dotenv = original
