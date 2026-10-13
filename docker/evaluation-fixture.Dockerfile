FROM statigent-runtime:dev
# This is a command-agent fixture, not the interactive script backend.
LABEL org.statigent.fresh-script="unsupported"
COPY python/statigent_evaluation/fixture.py /opt/fixture.py
ENTRYPOINT ["uv", "run", "--offline", "--no-sync", "--frozen", "--project", "/opt/runtime", "python", "/opt/fixture.py"]
