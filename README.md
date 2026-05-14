# statigent

A data science agent for automated analysis, feature engineering, model building, and insight generation.

## Setup

Set the `DEEPSEEK_API_KEY` environment variable to use the default model profiles (deepseek-v4-flash):

```bash
export DEEPSEEK_API_KEY="your-api-key-here"
```

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
