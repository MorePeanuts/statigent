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

- **datascience** — numpy, pandas, scikit-learn, torch, etc. Required for agent data analysis and modeling
- **benchmark** — mlebench. Required for MLE-Bench evaluation

```bash
uv sync --group datascience
uv sync --group benchmark
uv sync --all-groups          # Install all groups
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

## Custom Models

The default model profiles are defined in `src/statigent/models/defaults.toml`. To use your own models, create a custom TOML file and load it:

```python
from statigent import load_registry

registry = load_registry("path/to/my_models.toml")
model = registry.get_model("my-model")
```

The TOML format follows the same structure as `defaults.toml` — each section is a profile name, and its keys are passed to `langchain.init_chat_model`:

```toml
[my-gpt4]
model = "gpt-5.4"
model_provider = "openai"

[my-claude]
model = "claude-sonnet-4.6"
model_provider = "anthropic"
```
