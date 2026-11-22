# DSH Orchestra

[简体中文](README.md) · [English](README.en.md)

**Send one task in DSH, run independent steps in parallel, and get deliverables you can verify in the original conversation.**

DSH Orchestra is a workflow orchestration plugin for DeepSeek Harness (DSH). Describe the goal, available materials, and expected deliverables. The planner proposes steps, models, and execution order. From one task card you can track each step, open the actual deliverables, and decide when to authorize work, accept results, or send a revision back.

- **Reconcile records** · Check receipts, refunds, and samples independently, then consolidate the required results.
- **Research and write** · Split research by topic and give the final writing step the registered findings it needs.
- **Review and revise** · Read a result alongside its criteria and send feedback to the step that produced it. Review the new version when it is ready.

[Quick start](#quick-start) · [Capabilities](#capabilities) · [Architecture](#architecture) · [Usage](#usage) · [Development and validation](#development-and-validation) · [License](#license)

![Orchestra desktop workflow view showing parallel checks, a join, and different reasons for waiting](docs/assets/readme/workflow.png)

*An isolated acceptance-test screenshot. Sales and cost checks feed the consolidation step. The independent archive step has its own status.*

## Quick start

### Install

1. Obtain an Orchestra plugin archive (`.tgz`) compatible with your DSH version, or [build it from source](#development-and-validation).
2. Install it using the DSH Desktop plugin manager. Reload as requested by DSH and check that **Orchestra** appears in the sidebar. The package registers its server and web client through Cordis.
3. Open a workspace and a normal conversation within it. Under **Orchestra → Settings**, check the service connection, model configuration, and automatic task routing. The personal Desktop adapter enables automatic routing for explicit work requests by default. The planner follows the conversation model by default. You can pin a configured provider, model, and supported reasoning effort. Worker models are configured separately.
4. The package targets the DSH `0.2.2` series. Native Desktop chat routing and approval acceptance runs used `0.2.2-rc.5`. Check the health panel and host integration for other environments.

### Send a synthetic task from the original conversation

Send this message with automatic routing enabled. When automatic routing is off, prefix it with `/orchestra `. Ordinary questions stay in the DSH conversation.

~~~
Please calculate the net amount for this synthetic exercise. Use only the two simulated receipts of 83.25 and 41.75 and the simulated refund of 15.50 provided here. Write the inputs, calculation, and net result to a new dedicated Markdown deliverable named orchestra-sample-net.md. Show two decimal places.
~~~

Look for the Orchestra acceptance receipt. In **Tasks → this run → Results**, open the registered deliverable. The expected net amount is **109.50**. The original conversation receives applicable approval requests, actionable blocks, and results. Use the task panel or ask about the named task in the original conversation to check progress.

## Design principles

- **Plan before dispatch.** The planner proposes the workflow, responsibilities, models, and deliverables. The service validates the pinned version, tool scope, approval requirements, and launch receipt.
- **Keep one card per task.** Expand it for named steps, use the workflow graph to see dependencies and joins, and use the queue to see why a step is waiting. Parallelism follows the task graph and configured capacity.
- **Reuse two layers of context.** Pin a version of project structure and constraints. Send the current goals, acceptance criteria, and applicable upstream results with each step.
- **Separate authorization from delivery review.** Launch and execution approvals ask for informed consent. Delivery review lets the operator read a specific result and accept it or send it back with concrete feedback.
- **Recover from recorded facts.** Timeouts, disconnections, and late reports remain distinguishable. A new attempt depends on trusted evidence and the retry policy of the published workflow.

## Capabilities

~~~mermaid
flowchart TD
    T["One task · one pinned plan"] --> S["Shared prerequisites · inputs and criteria"]
    S --> A["Check receipts"]
    S --> B["Check refunds"]
    S --> C["Independent spot check"]
    A --> J["Join · wait for declared dependencies"]
    B --> J
    C --> R["Record independent findings"]
    J --> D["Deliver the reconciliation"]
    R --> D
    D --> H{"Human review required?"}
    H -->|Yes| V["Review the artifact and criteria"]
    V -->|Request changes| F["Send specific feedback to the original step"]
    F --> N["Revise under the run policy"]
    N --> V
    V -->|Accept| E["Record the acceptance outcome"]
    H -->|No| E
~~~

| Capability | How it works |
| --- | --- |
| Natural-language routing | Explicit work requests can start in a normal Desktop conversation. `/orchestra` also works when automatic routing is disabled. The panel can show a plan before launch. |
| Versioned workflows | Edit drafts, validate, simulate, publish versions, and disable workflows. A run stays bound to its published definition. The planner can reuse an eligible workflow or generate one for a task. |
| Steps and parallel execution | Agent steps, waits, approvals, policy and branch steps, trusted tools, subworkflows, and dedicated parallel groups are subject to publishing rules and host support. Parallel groups support all, any, or quorum joins within topology constraints. |
| Models and capacity | Five complexity levels run from routine to expert. Set each model's capability ceiling, description, and supported reasoning effort. Configure session capacity, per-run parallelism, per-step concurrency across runs, and helpers per step. |
| Execution diagnostics | See the actual model, reasoning effort, attempts, timing, and evidence. Long runs, blocks, and repeated qualifying rework can trigger diagnosis. Escalation requires evidence and a stronger approved model. |
| Delivery review and rework | Browse registered artifacts, preview text, download original files, and review acceptance criteria. Feedback is tied to the exact version and can request a targeted revision or a scoped replan. |
| Cross-checks | Authorize a dependent step to verify an upstream finding independently. The operator can adopt or dismiss its conclusion and evidence. |
| Context, notes, and memory | Project snapshots and task context support the current run. Scoped notes carry operational information. Durable memory requires the host's memory plugin and human approval. |
| Recoverable execution | The ledger links events, receipts, attempts, and artifacts. Supported runbooks include continued observation, confirmation that an attempt never started, and verification of external effects. Retry eligibility depends on the pinned workflow and trusted evidence. |

<div>
  <img width="320" src="docs/assets/readme/board.png" alt="Narrow-window board with one task card expanded to show parallel steps">
  <img width="320" src="docs/assets/readme/queue.png" alt="Narrow-window queue distinguishing capacity, upstream dependencies, and human action">
</div>

*The same synthetic task in two views. The board groups the steps. The queue explains the waits.*

## Architecture

~~~mermaid
flowchart TD
    U["Operator · DSH conversation / Orchestra panel"]
    subgraph DS["Trusted DSH host"]
        G["Authenticated workspace and session"]
        M["Model catalog · child sessions · authorized tools"]
    end
    subgraph OR["Orchestra plugin"]
        P["Task planner · deliverables and policy checks"]
        W["Published versions · topology and dependencies"]
        D["Scheduler · capacity · step attempts"]
        X["DSH execution bridge"]
        C["Approval · delivery review · verification and recovery"]
        L[("SQLite single-writer ledger<br/>events · receipts · evidence · artifacts")]
        Q["Queries and event subscriptions"]
    end
    U --> G --> P --> W --> D --> X --> M
    P -.->|Planner model call| M
    M --> X --> C
    D --> C
    C -->|Authorization, acceptance, or guarded retry| D
    P --> L
    W --> L
    D --> L
    C --> L --> Q --> U
~~~

1. **Intake and planning.** Bind the request to the current workspace and conversation. Validate the planner's goals, deliverables, dependencies, tools, and risks.
2. **Version binding and scheduling.** Pin the run to a plan and workflow definition. Dispatch steps whose dependencies and capacity requirements are satisfied.
3. **Execution and settlement.** Create isolated DSH child sessions through the execution bridge. Provide scoped context and approved tools. Record reports, decisions, artifacts, and evidence.
4. **Visibility and recovery.** Read projections through authenticated queries and event subscriptions. Send actionable and terminal notices to the originating conversation. Resolve recovery actions against the original attempt and available evidence.

The service owns SQLite writes. The panel uses a trusted transport for queries and commands. The personal adapter isolates ledgers by workspace and conversation under `orchestra/personal` in the DSH data directory. A self-managed host binds authenticated operators to approval, collaboration, and rework operations. Access to models, tools, and data follows the host's permissions and the services' own policies.

## Usage

### Launch, track, and review work

~~~mermaid
sequenceDiagram
    actor User as Operator
    participant Chat as DSH conversation
    participant Engine as Orchestra
    participant Worker as Subagent
    User->>Chat: Submit the task and deliverable criteria
    Chat->>Engine: Bind the source conversation and plan
    opt Launch authorization required
        Engine-->>Chat: Show the scope and consequences
        User->>Chat: Authorize launch
    end
    Engine->>Worker: Dispatch when dependencies and capacity allow
    Worker-->>Engine: Register the result and execution evidence
    opt Human delivery review required
        Engine-->>Chat: Present the result and review criteria
        User->>Chat: Inspect and accept or request changes
        opt Changes requested
            Chat->>Engine: Bind feedback to the artifact version
            Engine->>Worker: Schedule rework under policy
            Worker-->>Engine: Register the revised version
            Engine-->>Chat: Request a new review
        end
    end
    Engine-->>Chat: Report the recorded outcome
~~~

- **From chat.** Provide the goal, allowed inputs, deliverables, and acceptance criteria. `/orchestra <task>` explicitly routes one request. The bare command shows its usage.
- **From the panel.** Use **Tasks → Plan with natural language** to check the selected workflow, deliverables, and permissions before launch. Start from a published workflow for repeat work.
- **Track parallel work.** Switch among the board, workflow, queue, and list. Open a run to see step attempts, results, evidence, and events.
- **Approve and review.** Handle launch and execution authorization in the conversation or approval center. In **Results → Delivery review and rework**, inspect the recorded version and submit specific feedback. In builds with conversational delivery review, a step held for review or a revised result awaiting acceptance also sends a structured notice to the originating conversation. Open the inline text or file controls and submit a verdict. Accepting the revised version settles its applicable review hold.
- **Retry after verification.** Enable the verified retry option for an agent step in a workflow draft and publish that version for new runs. See the [F8 acceptance report](docs/reviews/acceptance/f8-plugin-only-2026-11-21.md) for the evidence and host requirements.

![DSH Desktop results view with a synthetic artifact, preview, download, and rework controls](docs/assets/readme/results.png)

*An isolated Desktop acceptance test. The results view displays the registered artifact and available actions.*

### Shared context and settings

Create a plain UTF-8 `ORCHESTRA.md` at the authorized workspace root. Describe the project's goal, important locations, and verification rules. Keep the most important text in the first 120 lines and 4 KiB. The run pins one snapshot at first dispatch. Later steps reuse it and receive applicable task requirements and upstream artifact references.

Use **Settings** to configure planner and worker models, automatic routing, planning and execution limits, queue capacity, and workflow concurrency. DSH supplies the model catalog and available reasoning efforts. Approved tools determine what an agent can read. `local.allowWorkspaceListing` defaults to off and limits listing to allowed entries at the first level. A trusted host can set `local.sampleFile` to an explicitly authorized text file for sample reads.

### Personal Desktop and self-managed hosts

| Environment | Scope |
| --- | --- |
| Personal DSH Desktop | Local chat routing, planning, model configuration, run views, and supported human actions. The personal adapter does not wire shared trial rings, durable memory writes, or the QQ on-call connector. |
| Trusted self-managed DSH host | Use `serveDshOrchestra` with an isolated data path, phase, authorized sessions, executor, model catalog, and registered tools. Bind authenticated operators with `resolveHttpHuman` and provide authenticated workspace transport through `orchestraPanelTransport`. Configure memory, collaboration, or notification adapters as needed. |

When durable memory is wired, use **Organize as memory** from a successful run's results. Review the proposal, source, and scope before approving the write. Project snapshots and run notes are usable independently. See the [trial rings](docs/trial-circles.md) and [operations and rollback runbook](docs/runbook.md) for hosted controls.

### First-run troubleshooting

| What you see | Where to check |
| --- | --- |
| The conversation responds without an Orchestra receipt | Check automatic task routing under Settings and use a normal workspace conversation. Use `/orchestra` to route a single request explicitly. |
| A step stays pending | Check the queue for available capacity, upstream dependencies, or human action. Open the step for its selected model and blocking reason. |
| Planning timed out or a level has no model candidate | Check the planner, available models, and assessed capability levels. Adjust the planning budget to fit the task. |
| Your computer slept or DSH closed | Local execution depends on the running host. After reopening, inspect the original run and any recovery actions before proceeding. |

## Development and validation

| Path | Responsibility |
| --- | --- |
| [`src/index.ts`](src/index.ts) and [`src/service`](src/service/) | Host wiring, planning, workflow versions, dispatch, commands, evidence, and run queries |
| [`src/executor`](src/executor/) | DSH child-session bridge, model routing, tools, and execution reports |
| [`src/core`](src/core/) and [`src/infra`](src/infra/) | Workflow definitions, rules, state, and the SQLite ledger |
| [`src/client`](src/client/) | DSH sidebar, native chat tool views, and the operations panel |
| [`tests`](tests/) and [acceptance index](docs/reviews/acceptance/README.md) | Unit, contract, integration, and UI tests, plus acceptance evidence |

Use the Node and pnpm versions declared in [`package.json`](package.json). Run these commands in the repository root. The example uses PowerShell.

~~~powershell
pnpm install --frozen-lockfile
pnpm check
New-Item -ItemType Directory -Force .tmp/packages | Out-Null
pnpm pack --pack-destination .tmp/packages
~~~

Install the resulting `dsh-orchestra-*.tgz` in the intended DSH profile. A self-managed web profile can use `dsh plugin --profile web add <absolute-path-to-tgz>` and then wire its authenticated panel transport and workspace permissions. Use the installed DSH host's own package manager for plugin installation.

See the [design notes](docs/design-notes.md), [rework design](docs/design/rework-orchestration.md), [dispatch and view acceptance](docs/reviews/acceptance/dispatch-views.md), and [Desktop acceptance](docs/reviews/acceptance/desktop.md). The 24-hour soak and 72-hour R0 observation are separate formal S6 checks. Short-window evidence, targeted regression results, and installation receipts are recorded for their own candidates. Release status follows the evidence for the same frozen candidate.

## License

Source is available for use without charge for purposes permitted by the PolyForm Noncommercial License 1.0.0. Commercial use requires separate authorization from the rights holder. The license text governs use, copying, modifications, distribution, and its listed permitted purposes. DSH, third-party dependencies, and model providers have their own terms. [License text](LICENSE) · [Official PolyForm terms](https://polyformproject.org/licenses/noncommercial/1.0.0)
