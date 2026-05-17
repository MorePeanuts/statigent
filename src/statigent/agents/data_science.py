import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from statigent.benchmarks.base import AgentTrace
from statigent.exploration import (
    Coder,
    Debugger,
    ExplorationOrchestrator,
    Inspector,
    Reviewer,
)
from statigent.input import InputProfiler, TaskBriefPlanner
from statigent.models import get_model
from statigent.notebook import DockerNotebookKernel, NotebookContext
from statigent.output import OutputRenderer
from statigent.schemas import DatasetProfile, ExplorationReport, TaskBrief, TaskType


class _Profiler(Protocol):
    def profile_paths(self, paths: list[Path] | None) -> DatasetProfile: ...


class _Planner(Protocol):
    def create_brief(
        self,
        *,
        prompt: str,
        task_instructions: str,
        profile: DatasetProfile,
    ) -> TaskBrief: ...


class _Orchestrator(Protocol):
    def run(self, brief: TaskBrief, profile: DatasetProfile) -> ExplorationReport: ...


OrchestratorFactory = Callable[[TaskBrief, DatasetProfile, Path], _Orchestrator]


class StatigentDataScienceAgent:
    name = "statigent-data-science"

    def __init__(
        self,
        model_name: str = "deepseek-v4-flash",
        *,
        profiler: _Profiler | None = None,
        planner: _Planner | None = None,
        orchestrator_factory: OrchestratorFactory | None = None,
        renderer: OutputRenderer | None = None,
    ) -> None:
        self.model_name = model_name
        self.profiler = profiler
        self.planner = planner
        self.orchestrator_factory = orchestrator_factory
        self.renderer = renderer or OutputRenderer()

    def run_analysis_for_eval(
        self,
        prompt: str,
        *,
        files: list[Path] | None = None,
        task_instructions: str = "",
    ) -> tuple[str, AgentTrace]:
        work_dir = Path(tempfile.mkdtemp(prefix="statigent-agent-"))
        profile = self._profiler(work_dir).profile_paths(files)
        brief = self._planner().create_brief(
            prompt=prompt,
            task_instructions=task_instructions,
            profile=profile,
        )
        trace: AgentTrace = [
            {"role": "system", "content": profile.compact_summary(), "name": "input"},
            {
                "role": "assistant",
                "content": brief.model_dump_json(),
                "name": "task_brief",
            },
        ]
        if brief.task_type in {
            TaskType.DATA_MODELING,
            TaskType.DEEP_ANALYSIS,
            TaskType.UNKNOWN,
        }:
            bundle = self.renderer.render_unsupported(brief)
            trace.append(
                {"role": "assistant", "content": bundle.content, "name": "output"}
            )
            return bundle.content, trace

        orchestrator = self._orchestrator(brief, profile, work_dir)
        report = orchestrator.run(brief, profile)
        bundle = self.renderer.render(brief, report)
        trace.append(
            {
                "role": "assistant",
                "content": bundle.model_dump_json(),
                "name": "output",
            }
        )
        return bundle.content, trace

    def run_modeling_for_eval(
        self,
        prompt: str,
        *,
        train_path: Path,
        test_path: Path,
        sample_submission_path: Path,
        task_instructions: str = "",
        work_dir: Path | None = None,
    ) -> tuple[Path, AgentTrace]:
        target_dir = work_dir or Path(tempfile.mkdtemp(prefix="statigent-modeling-"))
        response, trace = self.run_analysis_for_eval(
            prompt,
            files=[train_path, test_path, sample_submission_path],
            task_instructions=task_instructions,
        )
        trace.append(
            {
                "role": "assistant",
                "content": (
                    f"Modeling submission generation is not implemented: {response}"
                ),
                "name": "modeling_placeholder",
            }
        )
        return target_dir / "submission.csv", trace

    def _profiler(self, work_dir: Path) -> _Profiler:
        if self.profiler is not None:
            return self.profiler
        return InputProfiler(work_dir=work_dir)

    def _planner(self) -> _Planner:
        if self.planner is not None:
            return self.planner
        return TaskBriefPlanner(model=get_model(self.model_name))

    def _orchestrator(
        self,
        brief: TaskBrief,
        profile: DatasetProfile,
        work_dir: Path,
    ) -> _Orchestrator:
        if self.orchestrator_factory is not None:
            return self.orchestrator_factory(brief, profile, work_dir)
        model = get_model(self.model_name)
        kernel = DockerNotebookKernel()
        kernel.start(
            NotebookContext(
                input_paths=[file.path for file in profile.files],
                work_dir=work_dir,
                timeout_seconds=brief.budgets.timeout_seconds,
            )
        )
        return ExplorationOrchestrator(
            inspector=Inspector(model),
            reviewer=Reviewer(model),
            coder=Coder(model),
            debugger=Debugger(model),
            kernel=kernel,
        )
