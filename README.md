# statigent

A data science agent for automated analysis, feature engineering, model building, and insight generation.

## Setup

Set the `DEEPSEEK_API_KEY` environment variable to use the default model profiles (deepseek-v4-flash):

```bash
export DEEPSEEK_API_KEY="your-api-key-here"
```

To use custom model configurations, provide your own `models.toml` via `load_registry(path)`.
