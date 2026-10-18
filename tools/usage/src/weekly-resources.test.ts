import { describe, expect, it } from "vitest";
import { formatPercent, isDeskpetWorker, overlaps, percentage, renderMarkdown, selectDeskpetRuns, taskRates, tokenShares } from "../weekly-resources.mjs";

const from = "2026-10-12T00:00:00Z";
const to = "2026-10-19T00:00:00Z";

describe("weekly resources", () => {
  it("calculates input shares including cache tokens and both Opus denominators", () => {
    const tsv = [
      "tool\trole\tmodel\tsessions\tcalls\tinput\tcacheRead\tcacheWrite\toutput\tinShare",
      "claude\tcoordinator\tclaude-opus-5-5\t1\t10\t1.00M\t39.00M\t0.00M\t1.00M\t40%",
      "claude\tcoordinator\tclaude-sonnet-5-5\t1\t10\t0.00M\t20.00M\t0.00M\t1.00M\t20%",
      "codex\tworker\tgpt-6-sol\t1\t-\t10.00M\t30.00M\t0.00M\t1.00M\t40%",
      "total input-side 100.00M, output 3.00M; coordinator 60% of input, 67% of output",
    ].join("\n");
    expect(tokenShares(tsv)).toEqual({ coordinator: 60, opusWithinCoordinator: 67, opusOverall: 40 });
    expect(tokenShares("bad output")).toBeNull();
    expect(percentage(1, 0)).toBeNull();
  });

  it("selects runs by a DeskPet worker worktree, including mixed runs", () => {
    const deskpet = { resource: { worktreeId: "host::C:\\Users\\Example\\orca\\workspaces\\deskpet\\m14" } };
    const other = { resource: { worktreeId: "host::C:/Users/Example/orca/workspaces/external-tools/m14" } };
    expect(isDeskpetWorker(deskpet)).toBe(true);
    expect(selectDeskpetRuns([{ run: "mixed", workers: [other, deskpet] }, { run: "other", workers: [other] }]).map((item) => item.run)).toEqual(["mixed"]);
  });

  it("counts only overlapping dispatches and in-period task titles", () => {
    const tasks = [
      { id: "a", task_title: "M14 fix display", created_at: "2026-10-13T00:00:00Z" },
      { id: "b", task_title: "보완", created_at: "2026-10-14T00:00:00Z" },
      { id: "c", task_title: "new feature", created_at: "2026-10-15T00:00:00Z" },
      { id: "old", task_title: "수정", created_at: "2026-10-10T00:00:00Z" },
    ];
    const dispatches = [
      { taskId: "a", dispatchedAt: "2026-10-12T00:00:00Z", completedAt: "2026-10-13T00:00:00Z" },
      { taskId: "a", dispatchedAt: "2026-10-15T00:00:00Z", completedAt: "2026-10-15T01:00:00Z" },
      { taskId: "b", dispatchedAt: "2026-10-11T00:00:00Z", completedAt: "2026-10-12T01:00:00Z" },
      { taskId: "b", dispatchedAt: "2026-10-10T00:00:00Z", completedAt: "2026-10-11T00:00:00Z" },
    ];
    expect(overlaps("2026-10-11T00:00:00Z", "2026-10-12T01:00:00Z", from, to)).toBe(true);
    expect(overlaps("2026-10-11 23:00:00", "2026-10-12 01:00:00", from, to)).toBe(true);
    expect(overlaps("2026-10-11T00:00:00Z", "2026-10-12T00:00:00Z", from, to)).toBe(false);
    expect(overlaps("2026-10-19T00:00:00Z", null, from, to)).toBe(false);
    expect(taskRates(tasks, dispatches, from, to)).toEqual({ retry: 50, retried: 1, workerTaskCount: 2, followUp: 67, followUpCount: 2, taskCount: 3 });
  });

  it("keeps unavailable measurements explicit", () => {
    expect(formatPercent(null, "도구 없음")).toBe("미확인(도구 없음)");
    const output = renderMarkdown({ tokens: null, tokenReason: "도구 없음", rates: null, orcaReason: "Orca 읽기 오류", codex: null, codexReason: "Codex 기록 없음" });
    expect(output).toContain("미확인(도구 없음)");
    expect(output).toContain("미확인(Orca 읽기 오류)");
    expect(output).toContain("미확인(Codex 기록 없음)");
  });
});
