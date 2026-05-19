# statigent

A data science agent for automated analysis, feature engineering, model building, and insight generation.

## Prerequisites

### Install

[uv](https://docs.astral.sh/uv/) is the package manager. Install it first if you haven't:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Clone and install the project:

```bash
git clone --recurse-submodules <repo-url> && cd statigent
uv sync
```

If you already cloned without `--recurse-submodules`, initialize them with:

```bash
git submodule update --init
```

Optional dependency groups:

- **benchmark** — mlebench. Required for MLE-Bench evaluation and DSBench (data modeling evaluation)

```bash
uv sync --group benchmark
uv sync --all-groups          # Install all groups
```

### Docker (Required for Agent Execution)

The baseline agent executes code inside Docker containers for isolation. Install Docker Desktop:

- **macOS**: https://docs.docker.com/desktop/install/mac-install/
- **Linux**: https://docs.docker.com/engine/install/

Then build the sandbox image:

```bash
docker build -t statigent/ds-sandbox .
```

### API Keys

Model access is configured via environment variables. LangChain auto-discovers keys by provider name:

| Variable | Provider | Required for |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek | Default model profiles |
| `OPENAI_API_KEY` | OpenAI | GPT models |
| `ANTHROPIC_API_KEY` | Anthropic | Claude models |

Set them in your shell or a `.env` file at the project root:

```bash
export DEEPSEEK_API_KEY="your-api-key-here"
```

### Kaggle API (MLE-Bench only)

MLE-Bench downloads datasets from Kaggle, which requires API credentials:

1. Go to https://www.kaggle.com → Settings → API → Create New Token
2. Place the downloaded `kaggle.json` in `~/.kaggle/`
3. Restrict permissions: `chmod 600 ~/.kaggle/kaggle.json`

## Evaluation

Run benchmarks to evaluate agent performance:

```python
from statigent.benchmarks import run_benchmark
from statigent.baseline import ReactBaselineAgent

agent = ReactBaselineAgent(model_name="deepseek-v4-flash")
result = run_benchmark("dabench", agent)
print(f"Score: {result.score}")
```

Available benchmarks: `dabench`, `dsbench-da`, `dsbench-dm`, `mlebench`. For detailed usage, data preparation, and per-benchmark options, see [docs/how_to_eval.md](docs/how_to_eval.md).

## Baseline Agents

### React Baseline

The React baseline agent (`ReactBaselineAgent`) uses langchain's `create_agent` with a Docker sandbox. Each evaluation task runs in an isolated container:

- **Tools**: `bash`, `python`, `read_file`, `write_file`, `list_dir`
- **Execution model**: One Docker container per task. Data directories are bind-mounted read-only; output files are extracted after task completion.
- **Network**: Disabled by default. Pass `sandbox_network=True` to enable.

```python
from statigent.baseline import ReactBaselineAgent

agent = ReactBaselineAgent(
    model_name="deepseek-v4-flash",
    sandbox_image="statigent/ds-sandbox",
    sandbox_network=False,
    sandbox_timeout=600,
)
```

## Custom Models

The default model profiles are defined in `src/statigent/models/defaults.toml`. To use your own models, create a custom TOML file and load it:

```python
from statigent import load_registry

registry = load_registry("path/to/my_models.toml")
model = registry.get_model("my-model")
```

The TOML format follows the same structure as `defaults.toml` — each section is a profile name, and its keys are passed to `langchain.init_chat_model`:

```toml
[gpt-5_4]
model = "gpt-5.4"
model_provider = "openai"

[claude-sonnet-4_6]
model = "claude-sonnet-4.6"
model_provider = "anthropic"
```
