FROM ghcr.io/astral-sh/uv:0.8.22 AS uv
FROM python:3.12.9-slim-bookworm
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/runtime/.venv \
    PYTHONPATH=/opt/runtime/python PYTHONDONTWRITEBYTECODE=1 \
    JUPYTER_RUNTIME_DIR=/tmp/jupyter IPYTHONDIR=/tmp/ipython \
    MPLCONFIGDIR=/tmp/matplotlib HOME=/tmp \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
WORKDIR /opt/runtime
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY python ./python
RUN groupadd --gid 10001 runtime && useradd --uid 10001 --gid 10001 --no-create-home runtime \
    && mkdir /input /workspace && chown runtime:runtime /workspace
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["uv", "run", "--offline", "--no-sync", "--project", "/opt/runtime", "python", "-m", "statigent_runtime.bridge"]
