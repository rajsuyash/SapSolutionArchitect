# To-Be quality optimisation loop: status 2026-10-29

Goal: a To-Be plan good enough to replace an expert SAP consultant, scored above 90/100 by an independent judge. **Not reached yet.** Best score: **87.76**. Work is paused because both model providers are out of funds.

## How quality is measured

- Input: the tester's real discovery (project 349a9ce0…, variant JOB_WORK_SUBCONTRACTING_FORGED_BLANK): 14 As-Is steps, 35 requirements, 24 company-context answers, 28 open questions, confirmed as a draft with gaps.
- Generation: `scripts/run-tobe.ts` runs the production To-Be stage locally on the saved report and workspace state, with the production model settings.
- Scoring: `scripts/report-to-judge.ts` prepares the judge files; `scripts/eval-judge.ts` scores them against a 100-point rubric with Qwen3.8-Max, an independent model family. Since iteration 9: 5 judge passes per design, median reported.
- Noise: the same design varies by up to ~13 points between judge passes, and two generations from one input differ by a similar margin. Single runs are not reliable evidence.

## Scores

| Run | Setup | Score |
|---|---|---|
| Production To-Be, before this work (adapter with derived sections) | OpenRouter DeepSeek | **87.76** |
| Iteration 5 | OpenRouter | 77.55 |
| Iteration 6a | OpenRouter | 78.28 |
| Iteration 7a / 7b (outline effort "high") | OpenRouter | 80.81 / 75.76 |
| Iteration 8a / 8b | OpenRouter | 83.33 / 77.27 |
| Iteration 8a without the review-findings list | OpenRouter | 87.76 |
| Iteration 12b (review skipped: time budget) | DeepInfra DeepSeek | 83.84 |
| Iteration 13a / 13b (30-minute budget, review ran) | DeepInfra | 76.77 / 76.77 |
| Iteration 13a without the review-findings list | DeepInfra | 78.79 |
| Ablation: current code, original prompts | DeepInfra | 78.83 / 82.14 |

Iterations 1–4, 9–11 and 14 produced no score (validation failures, timeouts, or no credit); each failure led to a fix listed below.

## Criteria that lose points in every run

DIM-LOGIC (weight 8: contradictions between steps and registers), DIM-USE (4), CL10 status models, CL19 RICEFW list, CL23 KPI baselines (2 each). Together about 9 points: the gap to 90. Typical DIM-LOGIC findings: a plant's company code differs between steps; one step posts a charge another says was never posted; returns are weighed at the gate in one step and not in another; coverage says "implemented" while the step holds the behaviour pending a question.

## What changed (commits 57a53dc, then two later commits on this branch)

Reliability (removed failure modes seen live):
- `AI_OUTLINE_REASONING_EFFORT`: outline reasoning control. The outline was hitting its output ceiling because reasoning tokens count against it; "high" cut outline calls from 3–4 to 1–2. DeepSeek on DeepInfra now gets `thinking` for the outline (it does not reason without it).
- Outline starts at a 32k ceiling; a cut-off answer falls back to the second model only at the 64k cap; a primary timeout hands the stage to the fallback.
- The model sees short ids (RQ-n, AS-n, IQ-n) instead of UUID ids it mis-copied; ids are mapped back on output; near-miss long ids are repaired.
- Server-side fixes instead of whole-run failures: KPI values normalised per measure, duplicate and abbreviated roles merged, owners added to the role catalogue, duplicate status models and configuration rows merged, document-type rows added, RICEFW type inferred, placeholder check no longer rejects field names like "value".

Readability and evidence:
- Open questions shown as IQ-n and registered as open decisions with owner and affected steps; dangling question references flagged.
- Person names from the chat removed from the design.
- KPIs without a baseline get a measurement plan.

Consistency (committed, **not yet scored**):
- The outline decides once which step posts what (`postingSummary`) and shared `processFacts`; every step, register and review request receives them.
- A unit cited with a code different from the org structure is rewritten to the org-structure code.
- A coverage row marked implemented while its step holds the behaviour pending a question becomes conditional.
- `AI_TO_BE_REVIEW_ROUNDS` (default 2) adds a second consistency review.

Tests: 1,350 pass, type check clean. Nothing from this loop is deployed or pushed.

## Lessons

- Server-side deterministic fixes stick; asking the model to repair its own output often fails and, as a hard error, fails the whole generation.
- Adding prompt rules did not measurably help: the original prompts score the same within noise.
- Disclosed review findings cost about 2–4 points; most of the gap is in the design itself.
- On DeepInfra, generation takes ~1,450 s and the 1,200 s production budget leaves no time for review; production also runs `AI_MAX_CONCURRENCY=1`.
- The test loop spent the shared production budget (OpenRouter $30 workspace cap, DeepInfra balance), taking production AI down with it. A separate eval key or budget is needed.

## Blockers

1. **OpenRouter**: workspace monthly budget of $30 exhausted (403); resets 2026-11-01. Production To-Be generation uses it.
2. **DeepInfra**: zero balance (402). The web chat and the fallback use it, so production AI is down.
3. **Billing move** to Google billing account 010F18-F2D9BF-DB0180: two commands still waiting to be run (grant suyash@voxdonna.com Billing Account User via rajsuyash@gmail.com, then link the project).

## Next steps once a provider is funded

1. Score the committed consistency changes: 2 generations × 5 judge passes.
2. Test `AI_MAX_CONCURRENCY=4` with `AI_TO_BE_REVIEW_ROUNDS=3` so the review has time to run.
3. Deploy the reliability work and confirm with the live Chrome flow (confirm as draft, generate, judge).
4. Use a dedicated eval budget so testing cannot exhaust production credit.
