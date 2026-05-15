## DABench

Path: `../benchmarks/InfiAgent-DABench/examples/DA-Agent/`

### 评测流程概览

DABench 是一个 **闭式（closed-form）** 数据分析智能体评测基准，包含 257 道题，覆盖 68 个 CSV 数据集，核心流程分三步：

生成回答 → 格式重整 → 评分

---
### 你的智能体如何接入评测

你不需要使用它自带的 REACT pipeline，核心只需做到一点：生成符合格式要求的回答文件。

**Step 1：生成回答**

让你的智能体对 257 道题逐一回答，输出一个 JSONL 文件，每行格式：

```jsonl
{"id": 0, "response": "The mean fare is @mean_fare[34.65]"}
{"id": 6, "response": "@mean_fare_child[31.09], @mean_fare_teenager[31.98]"}
```

关键字段：
- id：与 data/da-dev-questions.jsonl 中的题目 ID 对应
- response：包含 `@answer_name[answer]` 模式的回答

answer_name 和 answer 必须与题目 format 字段及 data/da-dev-labels.jsonl 中的标签匹配。判断相等时支持精确字符串匹配和浮点数近似匹配（容差 1e-6）。

每道题的题目文件包含：question（问题文本）、constraints（求解约束，如用什么库、如何取整）、format（输出格式模板）、file_name（对应的 CSV 文件）。

**Step 2：格式重整（推荐）**

因为大多数模型难以严格遵守 `@name[value]` 格式，建议用 reformat.py 做一次清洗：

```bash
python3 reformat.py \
  --questions_file_path data/da-dev-questions.jsonl \
  --responses_file_path your_responses.jsonl \
  --model gpt-3.5-turbo-16k
```

需要在脚本同目录下准备 url.txt（API 端点）和 api_key.txt（API 密钥）。

**Step 3：评分**

```bash
python3 eval_closed_form.py \
  --questions_file_path data/da-dev-questions.jsonl \
  --labels_file_path data/da-dev-labels.jsonl \
  --responses_file_path your_responses.jsonl
```

输出三个指标：

| 指标 | 含义 | 严格程度 |
|------|------|----------|
| ABQ | 题目所有子答案全对才算对 | 最严格 |
| PSAQ | 每题 1 分，按子答案正确比例给分（如 2/3 正确得 0.67 分） | 中等 |
| UASQ | 每个子答案独立计分 | 最宽松 |

还会按 concept 类别（Summary Statistics、Correlation Analysis、Machine Learning 等）和题目难度（easy/medium/hard）做细分分析。

---
### 实践建议

1. 给智能体提供 CSV 数据访问能力——题目都需要对表做数据分析（pandas 等），你的智能体必须能执行 Python 代码并读取 CSV 文件
2. 让智能体严格遵循 format 字段的输出格式——这是评分的唯一接口，格式不对则无法提取答案
3. 注意 constraints 字段——它规定了求解细节（如随机种子、保留位数、使用哪个库），违反约束可能导致答案不匹配
4. 数值精度——浮点答案容差仅 1e-6，注意取整方式

## DSBench

Path: `../benchmarks/DSBench/`

### DSBench 评测框架解析

DSBench 包含两大评测任务，分别考察智能体的不同能力：

#### Data Analysis（数据分析任务）

- 数据来源：ModelOff 金融建模竞赛的真实题目
- 任务形式：给定任务说明（含图片/表格）+ Excel 数据文件，智能体需回答具体问题
- 题目数量：约 43 个 challenge，每个含多个子问题，涵盖选择题和数值计算题
- 评测指标：准确率（Accuracy）——用 LLM 判断预测答案是否与标准答案一致

**评测流程：**

data.json → 遍历每个 challenge
  → 读取 introduction.txt（背景介绍）
  → 读取 Excel 文件（转为文本）
  → 读取 questionN.txt（每个子问题）
  → 拼装 prompt 发给智能体
  → 收集回答保存到 save_process/{model}/{id}.json
→ compute_answer.py（用 GPT-4o 判断对错）→ results.json
→ show_result.py（汇总准确率、成本、耗时）

输出的关键格式——每个问题的预测结果需保存为 JSON 行：
{"id": "00000001", "model": "xxx", "input": 1234, "output": 567, "cost": 0.01, "time": 3.2, "response": "你的智能体的回答"}

#### Data Modeling（数据建模任务）

- 数据来源：74 个 Kaggle 竞赛（titanic、spaceship-titanic、各种 playground series 等）
- 任务形式：给定训练集 train.csv + 测试集 test.csv + 提交样例，智能体需产出预测结果的 CSV 文件
- 评测分为三个阶段：智能体运行 → 逐竞赛评分 → 归一化汇总

**阶段 1：智能体运行**

对每个竞赛，智能体收到以下输入：

| 输入 | 路径 | 说明 |
|------|------|------|
| 任务描述 | data/task/{name}.txt | 竞赛的说明文档，包含目标、字段含义、评测指标等 |
| 训练集 | data_resplit/{name}/train.csv | 用于训练 |
| 测试集 | data_resplit/{name}/test.csv | 需要预测的目标 |
| 提交样例 | data_resplit/{name}/sample_submission.csv | 规定了输出 CSV 的格式 |

注意：DSBench 对原始 Kaggle 数据做了重新切分（data_resplit），test 集带有真实标签，评测时用 data/answers/{name}/test_answer.csv 作为 ground truth。

智能体需产出两个文件保存到 output_model/{model}/：
- {name}.csv：预测结果，格式须与 sample_submission 一致
- {name}.json：元信息（model、input/output tokens、cost、time）

如果智能体未能产出有效 CSV（如代码执行出错、格式不对），该竞赛记为未完成。

**阶段 2：逐竞赛评分（score4each_com.py）**

对每个竞赛，调用该竞赛专属的 eval 脚本（evaluation/{name}_eval.py），将智能体的预测 CSV 与真实答案（data/answers/{name}/test_answer.csv）对比，计算原始 metric，结果写入 save_performance/{model}/{name}/result.txt。

不同竞赛使用不同的评测指标：

| 评测指标 | 使用的竞赛 | 方向 |
|----------|-----------|------|
| Accuracy | titanic, spaceship-titanic | 越高越好 |
| ROC-AUC | playground-s4e1, porto-seguro, santander-customer-transaction, santander-customer-satisfaction, amazon-employee-access | 越高越好 |
| RMSE | commonlitreadabilityprize | 越低越好 |
| RMSLE | bike-sharing-demand, tmdb-box-office-prediction, demand-forecasting-kernels-only | 越低越好 |
| R² | playground-s4e5 | 越高越好 |
| MAE | ventilator-pressure-prediction | 越低越好 |
| MCRMSE | feedback-prize-english-language-learning | 越低越好 |
| F1 (macro) | liverpool-ion-switching | 越高越好 |
| Mean Spearman | google-quest-challenge | 越高越好 |
| Jaccard | tweet-sentiment-extraction | 越高越好 |
| Normalized Gini | santander-value-prediction-challenge | 越高越好 |
| Log Loss | lmsys-chatbot-arena | 越低越好 |
| MAE (矩阵) | conways-reverse-game-of-life-2020 | 越低越好 |

**阶段 3：归一化汇总（show_result.py）**

这是最关键的部分。它将不同竞赛的异构指标统一到一个可比较的尺度：

$$score = \max\left(0,\ \frac{pred - baseline}{ground\\_truth - baseline}\right)$$

这个公式自动适配两种方向：
- "越高越好"的指标（如 Accuracy, AUC, F1）：gt > bl，gt - bl > 0，分子 pred - bl 越大分数越高
- "越低越好"的指标（如 RMSE, MAE, Log Loss）：gt < bl，gt - bl < 0，分子 pred - bl 也为负（pred 越小），负/负得正

三个参考点的含义：

| 值 | 含义 | 对应分数 |
|----|------|----------|
| baseline | 随机/简单基线的表现 | 0 |
| ground_truth | 用真实标签直接计算出的理论最优值 | 1 |
| 智能体表现 | 介于 baseline 和 GT 之间 | 0~1 |
| 智能体不如 baseline | — | 截断为 0 |

实际数据示例：

| 竞赛 | GT | Baseline | 含义 |
|------|-----|----------|------|
| titanic | 1.0 | 0.497 | Accuracy: 完美=1.0, 随机≈0.5 |
| playground-s4e1 | 1.0 | 0.5 | ROC-AUC: 完美=1.0, 随机=0.5 |
| commonlitreadabilityprize | 0.0 | 1.389 | RMSE: 完美=0, 差=1.389 |
| bike-sharing-demand | 0.0 | 4.801 | RMSLE: 完美=0, 差=4.801 |
| lmsys-chatbot-arena | 0.0 | 1.099 | Log Loss: 完美≈0, 随机≈1.099 |

**最终输出指标：**

show_result.py 输出四个汇总指标：

| 指标 | 计算方式 |
|------|---------|
| Task completion rate | 成功产出有效预测的竞赛数 / 总竞赛数 |
| Total cost | 所有竞赛的 API 调用成本之和 |
| Total time | 所有竞赛的运行时间之和 |
| Average normalized performance（核心） | 所有竞赛的归一化分数之和 / 总竞赛数 |

**关键设计要点：**

1. GT 并非 Kaggle 排行榜第一，而是用真实标签（test_answer.csv）直接计算的理论最优值——例如分类任务的 GT accuracy = 1.0，回归任务的 GT RMSE = 0
2. Baseline 是简单策略——分类任务通常取 0.5（随机猜测的 AUC），回归任务取训练集均值的预测误差
3. 归一化公式让不同竞赛可比较——无论原始指标是 accuracy、RMSE 还是 log loss，归一化后都是 0~1 的分数
4. 未完成任务得分 0 而非排除——这激励智能体尽量完成所有竞赛，而不是只挑简单的做

---
### 如何评测你自己的智能体

你需要做的核心工作是：编写适配层，将 DSBench 的输入格式转为你的智能体的输入，并将你的智能体的输出转为 DSBench 期望的格式。

#### Data Analysis 任务的接入步骤

**Step 1：下载数据**

```bash
cd data_analysis
# 从 Google Drive 或 HuggingFace 下载 data.zip 并解压
```

**Step 2：编写评测脚本**

参考 eval_GPT.ipynb 的逻辑，将其中调用 GPT API 的部分替换为调用你的智能体。核心逻辑如下：

```python
import json

samples = []
with open("./data.json", "r") as f:
    for line in f:
        samples.append(eval(line.strip()))

model = "your-agent-name"
save_path = f"./save_process/{model}"

for sample in samples:
    if len(sample["questions"]) > 0:
        # 1. 读取输入
        introduction = read_txt(f"./data/{sample['id']}/introduction.txt")
        excel_content = ""  # 读取 Excel 转文本（如有）
        image = None  # 读取图片路径（如有）

        answers = []
        for qid, question_name in enumerate(sample["questions"]):
            question = read_txt(f"./data/{sample['id']}/{question_name}.txt")
            prompt = f"{excel_content}\n{introduction}\n{question}"

            # 2. ★ 替换为你的智能体调用 ★
            start = time.time()
            response = your_agent.run(prompt, image=image)
            cost = your_agent.get_cost()  # 或自行计算
            elapsed = time.time() - start

            # 3. 保存为 DSBench 期望的格式
            answers.append({
                "id": sample["id"],
                "model": model,
                "input": 0,      # token 数（如无可用 0）
                "output": 0,
                "cost": cost,
                "time": elapsed,
                "response": response  # ★ 关键：智能体的文本回答
            })

        # 4. 写入结果文件
        os.makedirs(save_path, exist_ok=True)
        with open(f"{save_path}/{sample['id']}.json", "w") as f:
            for ans in answers:
                json.dump(ans, f)
                f.write("\n")
```

**Step 3：计算正确性**

```bash
# 在 compute_answer.py 中设置你的 OpenAI key（用于 LLM 判断对错）
# 修改 model 变量为 "your-agent-name"
python compute_answer.py
```

**Step 4：查看结果**

```bash
# 修改 show_result.py 中的 model 变量
python show_result.py
```

#### Data Modeling 任务的接入步骤

**Step 1：下载数据**

```bash
cd data_modeling
# 下载 data.zip（含 data/、data_resplit/、evaluation/ 等）
# 下载 save_performance.zip（含 GT/、baseline/）并解压
```

解压后的关键目录结构：
- data/task/{name}.txt — 每个竞赛的任务描述
- data_resplit/{name}/ — 训练/测试/提交样例 CSV
- data/answers/{name}/test_answer.csv — 真实标签（ground truth），用于评分
- evaluation/{name}_eval.py — 每个竞赛的专属评分脚本
- GT/{name}/result.txt — 理论最优分数（来自 save_performance.zip）
- baseline/{name}/result.txt — 简单基线分数（来自 save_performance.zip）

**Step 2：编写评测脚本**

参考 eval_code_interpreter.ipynb，核心是让你的智能体对每个竞赛产出预测 CSV：

```python
import json, os, time, shutil

data = []
with open("./data.json", "r") as f:
    for line in f:
        data.append(eval(line))

model = "your-agent-name"
output_path = f"./output_model/{model}"
os.makedirs(output_path, exist_ok=True)

for line in data:
    name = line['name']

    # 1. 读取任务描述
    with open(f"./data/task/{name}.txt", "r") as f:
        description = f.read()

    # 2. 读取训练/测试数据
    train_data = f"./data_resplit/{name}/train.csv"
    test_data = f"./data_resplit/{name}/test.csv"
    sample_submission = f"./data_resplit/{name}/sample_submission.csv"

    # 3. ★ 调用你的智能体 ★
    start = time.time()
    result_csv = your_agent.run_modeling(
        task_description=description,
        train_path=train_data,
        test_path=test_data,
        sample_submission_path=sample_submission
    )
    elapsed = time.time() - start

    # 4. 保存预测结果为 {name}.csv（★ 格式须与 sample_submission 一致）
    # 保存 meta 信息为 {name}.json
    shutil.copy(result_csv, f"{output_path}/{name}.csv")
    with open(f"{output_path}/{name}.json", "w") as f:
        json.dump({
            "name": name, "model": model,
            "input": 0, "output": 0,
            "cost": 0, "time": elapsed
        }, f)
```

注意：DSBench 的 data_resplit 是对原始 Kaggle 数据的重新切分，test.csv 自带真实标签（用于评测），智能体在运行时应只使用 train.csv 训练、对 test.csv 做预测。

**Step 3：计算每个竞赛的 metric**

```bash
# 修改 score4each_com.py 中的 model 变量为 "your-agent-name"
python score4each_com.py
```

这一步会遍历所有竞赛，对每个竞赛：
1. 读取 GT/{name}/result.txt（理论最优）和 baseline/{name}/result.txt（基线分数）
2. 调用 evaluation/{name}_eval.py，传入预测 CSV 和 data/answers/{name}/test_answer.csv
3. 将原始 metric 写入 save_performance/{model}/{name}/result.txt

**Step 4：查看汇总结果**

```bash
# 修改 show_result.py 中的 model 变量
python show_result.py
```

输出四个汇总指标：
- **Task completion rate**：成功产出有效预测的竞赛比例
- **Total cost**：所有竞赛的 API 调用成本之和
- **Total time**：所有竞赛的运行时间之和
- **Average normalized performance（核心指标）**：所有竞赛归一化分数的均值，即 avg(max(0, (pred - baseline) / (gt - baseline)))

---
关键要点总结

| | Data Analysis | Data Modeling |
|------|----------------|---------------|
| 输入 | 背景文本 + Excel + 图片 + 问题文本 | 任务描述 + train.csv + test.csv + sample_submission.csv |
| 输出 | JSON 行文件（含 response 字段） | 预测 CSV（格式与 sample_submission 一致）+ JSON meta 文件 |
| 评测机制 | GPT-4o 判断对错 → 准确率 | 每个竞赛独立 eval 脚本计算原始 metric → 归一化公式统一为 0~1 分数 |
| 核心指标 | Accuracy（ABQ / PSAQ / UASQ） | Normalized Performance = max(0, (pred - baseline) / (gt - baseline)) |
| 接入核心 | 把智能体的文本回答写入 response 字段 | 把智能体的预测 CSV 放到 output_model/{model}/ |

简单来说：你只需要写一个适配脚本，把 DSBench 的输入喂给你的智能体，再把输出存成 DSBench 期望的文件格式，然后运行它提供的评测脚本即可得到标准化指标。

## MLE Bench

Path: `../benchmarks/MLE-Bench/`

MLE-Bench 是一个 ML 工程能力评测基准，包含 75 个 Kaggle 竞赛，通过将智能体的表现与真实 Kaggle 排行榜对比来评定奖牌。以下是你设计智能体后如何使用它进行评测的完整流程：

---
**1. 环境准备**

```bash
# 安装 Git LFS（数据集较大）
git lfs install

# 安装 mlebench 包
pip install -e .

# 配置 Kaggle API（下载数据集需要）
# 将 kaggle.json 放到 ~/.kaggle/
```

**2. 准备数据集**

每个竞赛的原始 Kaggle 数据会被 prepare.py 重新切分为 public（智能体可见）和 private（仅用于评分）两部分：

```bash
# 准备单个竞赛
mlebench prepare -c aerial-cactus-identification

# 准备 Lite 子集（22 个竞赛，约 158GB，推荐先用这个）
mlebench prepare --lite

# 准备全部 75 个竞赛（约 3.3TB）
mlebench prepare --all
```

**3. 让你的智能体运行竞赛**

有两种方式：

*方式 A：集成到 Docker 容器中（推荐，与已有 agent 一致）*

在 agents/ 下创建你的智能体目录：

```text
agents/my-agent/
├── config.yaml       # 智能体配置
├── Dockerfile        # 构建镜像
└── start.sh          # 启动脚本
```

config.yaml 格式：

```yaml
my-agent:
  start: agents/my-agent/start.sh
  dockerfile: agents/my-agent/Dockerfile
  kwargs_type: omegaconf
  kwargs:
    model: your-model-name
    steps: 500
  env_vars:
    YOUR_API_KEY: ${{ secrets.YOUR_API_KEY }}
    TIME_LIMIT_SECS: 86400
  privileged: false
```

关键约束：智能体在容器内需要：
- 读取 /home/data/description.md 获取竞赛描述
- 读取 /home/data/ 下的训练数据
- 产出 /home/submission/submission.csv 作为预测结果
- 可通过 http://localhost:5000/validate 验证提交格式（不透露分数）
- 不能手工标注，不能抄袭 Kaggle kernel

然后构建并运行：

```bash
# 构建镜像
docker build --platform=linux/amd64 -t my-agent agents/my-agent/ \
  --build-arg SUBMISSION_DIR=/home/submission \
  --build-arg LOGS_DIR=/home/logs \
  --build-arg CODE_DIR=/home/code

# 运行评测
python run_agent.py \
  --agent-id my-agent \
  --competition-set experiments/splits/low.txt \
  --n-seeds 3 \
  --n-workers 1
```

*方式 B：不使用 Docker（更灵活）*

只要你的智能体能产出 CSV 文件即可：

- 运行 mlebench prepare 准备数据
- 让智能体读取 public 数据，输出 submission.csv
- 直接用评分工具打分

**4. 评分**

```bash
# 单个竞赛评分
mlebench grade-sample <submission.csv> <competition-id>

# 批量评分（需要先构造 submission.jsonl）
# submission.jsonl 每行格式：
# {"competition_id": "xxx", "submission_path": "/path/to/submission.csv"}

# 从运行结果生成 submission.jsonl
python experiments/make_submission.py \
  --metadata runs/<run-group>/metadata.json \
  --output runs/<run-group>/submission.jsonl

# 批量评分
mlebench grade \
  --submission runs/<run-group>/submission.jsonl \
  --output-dir runs/<run-group>
```

**5. 汇总结果**

```bash
python experiments/aggregate_grading_reports.py \
  --experiment-id <exp_id> \
  --split low  # low=22个竞赛, medium, high, 或 all(75个)
```

**6. 评分机制**

- 每个竞赛有专属的评分函数（AUC-ROC、F1、RMSE、MAP@K 等）
- 分数与该竞赛的 Kaggle 历史排行榜对比，按 Kaggle 规则判定奖牌：

| 参赛队伍数 | 金牌 | 银牌 | 铜牌 |
|------------|------|------|------|
| <100 | 前10% | 前20% | 前40% |
| 100-249 | 第10名 | 前20% | 前40% |
| 250-999 | 第10+0.2%名 | 第50名 | 第100名 |
| 1000+ | 第10+0.2%名 | 前5% | 前10% |

- 核心指标：any_medal_percentage——获得任意奖牌的竞赛比例
- 需要至少 3 个 seed 取均值，结果报告为 mean ± SEM

**7. 额外检测**

```bash
# 规则违规检测（用 GPT-4o-mini 分析日志）
python extras/rule_violation_detector/run.py --run-group <group-id>

# 抄袭检测（对比 Kaggle 热门 kernel）
python extras/plagiarism_detector/run.py --submission <submission.csv>
```

推荐起点

- 先用 Lite 子集（22 个竞赛，experiments/splits/low.txt）快速验证
- 单个竞赛测试：experiments/splits/spaceship-titanic.txt
- 参照 agents/dummy/ 的实现作为最小可运行模板
- 正式评测用全部 75 个竞赛，3 seed，推荐配置：36 vCPU / 440GB RAM / 24GB GPU / 24h 时限

