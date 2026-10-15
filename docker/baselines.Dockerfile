FROM ghcr.io/astral-sh/uv:0.8.22 AS uv
FROM python:3.12.9-slim-bookworm
COPY --from=uv /uv /uvx /usr/local/bin/
# 固定系统 OpenMP 库版本；上游计算 wheel 需要它。
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1=12.2.0-14+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/runtime/.venv \
    UV_NO_DEV=1 \
    PYTHONPATH=/opt/runtime/python PYTHONDONTWRITEBYTECODE=1 \
    JUPYTER_RUNTIME_DIR=/tmp/jupyter IPYTHONDIR=/tmp/ipython \
    MPLCONFIGDIR=/tmp/matplotlib HOME=/tmp \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
WORKDIR /opt/runtime
ARG BASELINE_ENV=compute
COPY environments/baselines/${BASELINE_ENV}/pyproject.toml environments/baselines/${BASELINE_ENV}/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY python ./python
RUN groupadd --gid 10001 runtime && useradd --uid 10001 --gid 10001 --no-create-home runtime \
    && mkdir /input /workspace /bundle /output && chown runtime:runtime /workspace /output
USER 10001:10001
WORKDIR /workspace
LABEL org.statigent.fresh-script="2" org.statigent.modeling-stage="4" org.statigent.baseline-environment="1"
ENTRYPOINT ["uv", "run", "--frozen", "--offline", "--project", "/opt/runtime", "python", "-m", "statigent_runtime.bridge"]
