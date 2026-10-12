FROM statigent-runtime:dev
COPY python/statigent_evaluation/fixture.py /opt/fixture.py
ENTRYPOINT ["uv", "run", "--offline", "--no-sync", "--frozen", "--project", "/opt/runtime", "python", "/opt/fixture.py"]
