# Writing an Agent Skill a Model Actually Invokes

**Research date:** 2026-08-03
**Scope:** Anthropic's own documentation, the Agent Skills open standard, the Anthropic engineering blog, and Anthropic's public skill repository. Secondary write-ups were used only as leads and are not cited. Applied at the end to `skills/poppin/SKILL.md`.

## Executive conclusion

A skill is a directory with a `SKILL.md` whose YAML frontmatter carries exactly two required fields, `name` and `description`. Only that frontmatter is always in context; everything else is loaded lazily. ([specification](https://agentskills.io/specification), [Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview))

Three things determine whether a skill works:

1. **The description is the entire triggering mechanism.** It is the only text the model sees when deciding to load the skill, so it must state both *what* the skill does and *when* to reach for it, in the user's vocabulary rather than the implementation's. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions))
2. **The body is a recurring token cost, so it must earn every line.** Target under 500 lines and under ~5,000 tokens; push anything conditional into bundled files with an explicit statement of *when* to read each one. ([specification](https://agentskills.io/specification#progressive-disclosure), [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices))
3. **Only measurement tells you it works.** Triggering and output quality are separate failure modes with separate tests: a labelled should-trigger / should-not-trigger query set for the first, a with-skill versus without-skill baseline comparison for the second. ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions), [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills), [Claude Code skills](https://code.claude.com/docs/en/skills#evaluate-and-iterate-on-a-skill))

One documented conflict matters and is resolved in §2.4: Anthropic's platform docs say to *always* write descriptions in third person, while the Agent Skills site says to use imperative phrasing addressed to the agent, and Anthropic's own shipped skills use the imperative form.

## Evidence labels

- **Published fact** — stated in Anthropic documentation, the Agent Skills specification, or Anthropic's engineering blog.
- **Observation** — read directly from a real artifact (a SKILL.md in `github.com/anthropics/skills`, a skill installed on this machine, this repository's files). Practice, not guidance.
- **Inference** — a conclusion drawn from those, still needing validation.

---

## 1. The frontmatter contract

### 1.1 The portable core (Agent Skills specification)

**Published fact:** The specification defines six frontmatter fields, two required. ([specification](https://agentskills.io/specification))

| Field | Required | Constraints |
| --- | --- | --- |
| `name` | Yes | 1–64 chars. Lowercase `a-z`, digits `0-9`, hyphens only. No leading/trailing hyphen. No consecutive `--`. **Must match the parent directory name.** |
| `description` | Yes | 1–1024 chars, non-empty. What it does *and* when to use it. |
| `license` | No | License name, or the name of a bundled license file. Keep it short. |
| `compatibility` | No | Max 500 chars. Environment requirements: intended product, system packages, network access. Most skills do not need it. |
| `metadata` | No | Arbitrary string→string map for client-specific properties. Namespace your keys. |
| `allowed-tools` | No | Space-separated list of pre-approved tools. **Marked Experimental**; support varies by client. |

**Published fact:** Anthropic's platform docs add two constraints the spec table does not spell out: neither `name` nor `description` may contain XML tags, and `name` may not contain the reserved words `anthropic` or `claude`. ([Skills overview, Skill structure](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview#skill-structure))

**Published fact:** A reference validator exists — `skills-ref validate ./my-skill` checks frontmatter validity and naming conventions. ([specification, Validation](https://agentskills.io/specification#validation))

**Published fact:** The format was developed by Anthropic and released as an open standard now implemented by a long list of third-party agents. Sticking to the six spec fields is what makes a skill portable. ([Agent Skills overview](https://agentskills.io/))

### 1.2 Claude Code's extensions

**Published fact:** Claude Code implements the standard and adds fields on top. In Claude Code *all* frontmatter fields are optional; `name` defaults to the directory name and `description` falls back to the first paragraph of the body. ([Claude Code skills, Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference))

Fields beyond the spec, all optional:

| Field | Effect |
| --- | --- |
| `when_to_use` | Extra trigger phrases / example requests, appended to `description` in the skill listing. |
| `disable-model-invocation` | `true` removes the skill from Claude's context entirely; only the user can invoke it with `/name`. For anything with side effects — deploy, commit, send. |
| `user-invocable` | `false` hides it from the `/` menu; only Claude invokes it. For background knowledge that isn't an action. |
| `allowed-tools` | Pre-approves tools **for the invoking turn only**; the grant clears on the next user message. |
| `disallowed-tools` | Removes tools from the pool while the skill is active. |
| `model`, `effort` | Override model / reasoning effort for the turn. |
| `context: fork`, `agent`, `background` | Run the skill as a subagent with the body as its prompt. |
| `paths` | Glob patterns limiting automatic activation to matching files. |
| `argument-hint`, `arguments`, `hooks`, `shell` | Autocomplete hint, named positional args, lifecycle hooks, shell selection. |

**Published fact:** Claude Code substitutes `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` both in the body *and* inside Bash rules in `allowed-tools`, so a skill can invoke a bundled script with no permission prompt:

```yaml
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)
```

([Claude Code skills, string substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions))

**Inference:** `when_to_use`, `paths`, `disable-model-invocation`, and `context: fork` are Claude Code-only. A skill meant to run on other clients should carry its trigger text inside `description` rather than `when_to_use`, and treat `allowed-tools` as best-effort.

### 1.3 Where the file has to live

**Published fact (Claude Code):** Enterprise → personal (`~/.claude/skills/<name>/SKILL.md`) → project (`.claude/skills/<name>/SKILL.md`) → plugin (`<plugin>/skills/<name>/SKILL.md`). Name collisions resolve enterprise > personal > project, and any of them override a bundled skill. Plugin skills are namespaced `plugin-name:skill-name` and cannot collide. Project skills also load from `.claude/skills/` in every parent directory up to the repo root, and from nested subdirectory `.claude/skills/` once Claude touches a file there. ([Claude Code skills, Where skills live](https://code.claude.com/docs/en/skills#where-skills-live))

---

## 2. Description and triggering

### 2.1 The mechanism

**Published fact:** At startup only `name` + `description` from every skill are loaded into the system prompt. When a request matches a description, the agent reads the full `SKILL.md` off the filesystem. "The description carries the entire burden of triggering." ([Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview#level-1-metadata-always-loaded), [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#how-skill-triggering-works))

**Published fact:** Anthropic's engineering post is explicit: "Pay special attention to the `name` and `description` of your skill. Claude will use these when deciding whether to trigger the skill." ([Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills))

**Published fact:** Descriptions compete. "Claude uses it to choose the right Skill from potentially 100+ available Skills." ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#writing-effective-descriptions))

### 2.2 The undertriggering bias

**Published fact:** Agents only consult skills for work they cannot easily do alone. "A simple, one-step request like 'read this PDF' may not trigger a PDF skill even if the description matches perfectly, because the agent can handle it with basic tools. Tasks that involve specialized knowledge … are where a well-written description can make the difference." ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#how-skill-triggering-works))

**Published fact:** Anthropic's own `skill-creator` states the bias directly and prescribes the fix: "currently Claude has a tendency to 'undertrigger' skills — to not use them when they'd be useful. To combat this, please make the skill descriptions a little bit 'pushy'." Its worked example expands `"How to build a simple fast dashboard…"` into `"… Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a 'dashboard.'"` ([skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md))

**Published fact:** The same advice appears in the standard's guidance: "Err on the side of being pushy. Explicitly list contexts where the skill applies, including cases where the user doesn't name the domain directly." ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#writing-effective-descriptions))

### 2.3 What makes a description fire

**Published fact**, consolidated from [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#writing-effective-descriptions), the [specification](https://agentskills.io/specification#description-field) and [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions):

- Say both what it does and when to use it. Descriptions like `Helps with documents`, `Processes data`, `Does stuff with files` are named as failures.
- Include specific key terms the user would actually type.
- Describe **user intent, not implementation** — "the agent matches against what the user asked for."
- Draw the negative boundary. When a skill over-triggers, "add specificity about what the skill does *not* do, or clarify the boundary between this skill and adjacent capabilities."
- Put the key use case first. In Claude Code the combined `description` + `when_to_use` is truncated at 1,536 characters in the listing, and the whole listing is capped at ~1% of the model's context window; when it overflows, descriptions are dropped starting with least-used skills. ([Claude Code skills, descriptions cut short](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short))
- Stay under the 1024-char hard limit — "descriptions tend to grow during optimization."

**Observation:** Anthropic's shipped document skills sit close to that ceiling and use explicit negative clauses. Measured character counts of `description` in `github.com/anthropics/skills`: `claude-api` 1077 (a multi-line YAML block scalar, over the spec's 1024 limit), `xlsx` 952, `docx` 837, `pptx` 740, `pdf` 437, down to `webapp-testing` and `frontend-design` at ~204. The `xlsx` description ends: *"Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."* ([xlsx SKILL.md](https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md), [docx SKILL.md](https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md))

**Inference:** Long, keyword-dense descriptions with explicit exclusions are the house style for skills that must win against near-neighbours. Short descriptions are reserved for skills with no close competitor. Description length should scale with how crowded the skill's neighbourhood is, not with the skill's size.

### 2.4 Third person vs. imperative — a real conflict

**Published fact:** Anthropic's platform docs carry a Warning: "**Always write in third person**. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems." Good: *"Processes Excel files and generates reports."* Avoid: *"I can help you process Excel files"* and *"You can use this to process Excel files."* ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#writing-effective-descriptions))

**Published fact:** The Agent Skills site says the opposite about form: "**Use imperative phrasing.** Frame the description as an instruction to the agent: 'Use this skill when…' rather than 'This skill does…' The agent is deciding whether to act, so tell it when to act." ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#writing-effective-descriptions))

**Observation:** Anthropic's own repository follows the imperative form for its highest-traffic skills. `pdf`, `docx`, `pptx`, and `xlsx` all open with `Use this skill whenever/any time…`. `internal-comms` is written in *first person from the user's perspective* ("A set of resources to help me write…") and then switches to third person mid-description ("Claude should use this skill whenever…"). ([pdf SKILL.md](https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md), [internal-comms SKILL.md](https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md))

**Inference:** The two rules only appear to conflict. The stable prohibition is against the *skill speaking as itself to the user* ("I can help you…"), which reads as dialogue rather than metadata. Both third-person descriptive ("Processes Excel files…") and imperative-to-the-agent ("Use this skill when…") are used by Anthropic in production. The safest construction, and the most common one in the repository, is the hybrid the platform docs' own examples use: one third-person clause naming the capability, then an imperative trigger clause — *"Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction."* Explicit trigger phrasing is documented guidance, **not folklore**: Claude Code ships a whole frontmatter field for it (`when_to_use`: "trigger phrases or example requests").

---

## 3. Progressive disclosure and budgets

**Published fact:** Anthropic calls progressive disclosure "the core design principle that makes Agent Skills flexible and scalable," describing three tiers: name+description in the system prompt at startup, full `SKILL.md` when relevance is determined, bundled files thereafter. ([engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills))

**Published fact:** The stated budgets:

| Level | Loaded | Cost | Content |
| --- | --- | --- | --- |
| 1 — Metadata | Always, at startup | ~100 tokens per skill | `name` + `description` |
| 2 — Instructions | On trigger | Under 5k tokens; **under 500 lines** | `SKILL.md` body |
| 3+ — Resources | On access | Zero until read | Bundled files; scripts' code never enters context, only their output |

([Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview#how-skills-work), [specification](https://agentskills.io/specification#progressive-disclosure), [best practices, Token budgets](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#token-budgets))

**Published fact:** "There's no context penalty for bundled content that isn't used" — a skill can ship comprehensive API docs or large datasets. Scripts are strictly cheaper than generated code: "the script's code never loads into the context window." ([Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview#the-skills-architecture))

**Published fact (Claude Code-specific, and important):** Once invoked, the rendered `SKILL.md` "enters the conversation as a single message and stays there for the rest of the session." Claude Code does not re-read the file on later turns. Under auto-compaction, only the first 5,000 tokens of each invoked skill are re-attached, sharing a combined 25,000-token budget filled most-recent-first, so older skills can be dropped entirely. ([Claude Code skills, Skill content lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle))

**Inference:** Two consequences follow from persistence. Write standing instructions ("whenever you show a result, do X") rather than one-time steps ("first, do X"), because the model will re-read this same text on turn 20. And put the load-bearing rules in the **first ~5,000 tokens** of the body, since that is the compaction survival window.

**Observation:** Anthropic does not treat 500 lines as hard. Line counts in `github.com/anthropics/skills`: `claude-api` 546, `skill-creator` 485, `algorithmic-art` 404, `doc-coauthoring` 375, `pdf` 314 — and at the other end `internal-comms` 32, `frontend-design` 55, `theme-factory` 59. `skill-creator` itself softens the rule: "These word counts are approximate and you can feel free to go longer if needed."

---

## 4. File structure

**Published fact:** The canonical layout, from the specification:

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation loaded on demand
├── assets/           # Optional: templates, images, data files
└── ...
```

`scripts/` should be self-contained or clearly document dependencies, include helpful error messages, and handle edge cases. `references/` files should be kept focused, since smaller files mean less context used. `assets/` holds templates, images, and lookup data. ([specification, Optional directories](https://agentskills.io/specification#optional-directories))

**Published fact — references must be one level deep.** "Claude may partially read files when they're referenced from other referenced files… Claude might use commands like `head -100` to preview content rather than reading entire files, resulting in incomplete information. **Keep references one level deep from SKILL.md.**" ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-deeply-nested-references))

**Published fact:** For reference files longer than 100 lines (Anthropic docs) or 300 lines (`skill-creator`), include a table of contents at the top so a partial read still reveals the file's full scope. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#structure-longer-reference-files-with-table-of-contents), [skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md))

**Published fact — the split decision.** Move content out when it is *conditional*, and say **when** to load it. "'Read `references/api-errors.md` if the API returns a non-200 status code' is more useful than a generic 'see references/ for details.'" Organize by domain so an unrelated domain costs nothing (`reference/finance.md`, `reference/sales.md`, not `docs/file1.md`). ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#structure-large-skills-with-progressive-disclosure), [Anthropic best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#progressive-disclosure-patterns))

**Published fact — the counter-rule.** Gotchas stay inline. "Keep gotchas in `SKILL.md` where the agent reads them before encountering the situation. A separate reference file works if you tell the agent when to load it, but for non-obvious issues, the agent may not recognize the trigger." ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#gotchas-sections))

**Published fact:** Always use forward slashes in paths, even on Windows. Name files by content (`form_validation_rules.md`, not `doc2.md`). Make execution intent explicit: "Run `analyze_form.py` to extract fields" (execute) versus "See `analyze_form.py` for the extraction algorithm" (read). ([best practices, Anti-patterns and Runtime environment](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#anti-patterns-to-avoid))

**Observation:** Actual layouts in `github.com/anthropics/skills` deviate from the `scripts/ references/ assets/` triad. `pdf/` puts its reference files at the skill root (`forms.md`, `reference.md`) alongside `scripts/`. `mcp-builder/` uses `reference/` singular. `webapp-testing/` uses `examples/`. `docx/`, `xlsx/` ship only `SKILL.md` + `scripts/`. `brand-guidelines/` is a bare `SKILL.md` + `LICENSE.txt`. Only `skill-creator/` uses all three of `scripts/`, `references/`, `assets/`.

**Observation:** `webapp-testing/SKILL.md` shows the black-box script pattern in production: *"Always run scripts with `--help` first to see usage. DO NOT read the source until you try running the script first and find that a customized solution is absolutely necessary. These scripts can be very large and thus pollute your context window. They exist to be called directly as black-box scripts rather than ingested into your context window."* ([webapp-testing SKILL.md](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md))

**Inference:** The directory names are convention, not contract — no loader keys off them. What is load-bearing is (a) one level of reference depth, (b) an explicit when-to-read for each file, and (c) an explicit read-vs-execute intent for each script.

---

## 5. Writing style for a model audience

**Published fact — assume competence.** "Default assumption: Claude is already very smart. Only add context Claude doesn't already have." The test questions given are: "Does Claude really need this explanation?", "Can I assume Claude knows this?", "Does this paragraph justify its token cost?" The standard's version: "Would the agent get this wrong without this instruction? If the answer is no, cut it." ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#concise-is-key), [agentskills best practices](https://agentskills.io/skill-creation/best-practices#add-what-the-agent-lacks-omit-what-it-knows))

**Published fact — imperative form.** `skill-creator`: "Prefer using the imperative form in instructions." ([skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md))

**Published fact — explain why, and treat ALL-CAPS as a smell.** `skill-creator`, in its own voice: "Try hard to explain the **why** behind everything you're asking the model to do. Today's LLMs are *smart*… **If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag** — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach." Echoed in the standard: "Reasoning-based instructions ('Do X because Y tends to cause Z') work better than rigid directives ('ALWAYS do X, NEVER do Y'). Models follow instructions more reliably when they understand the purpose." ([skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md), [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills#iterating-on-the-skill))

  **Note the tension:** the platform best-practices page suggests the opposite escalation — when Claude misses a rule, "Claude A might suggest… using stronger language such as 'MUST filter' instead of 'always filter'." ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#develop-skills-iteratively-with-claude)) **Inference:** emphasis is a legitimate tool for a single genuinely load-bearing rule; it stops working when it is the default register of the whole document.

**Published fact — degrees of freedom.** Match specificity to fragility, calibrating each section independently. The stated analogy: a narrow bridge with cliffs on both sides gets exact commands ("Run exactly this script… Do not modify the command or add additional flags"); an open field gets direction and trust ("Analyze the code structure… Check for potential bugs… Suggest improvements"). Three tiers: high freedom = prose instructions, medium = pseudocode or parameterised scripts, low = a specific script with few or no parameters. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#set-appropriate-degrees-of-freedom), [agentskills best practices](https://agentskills.io/skill-creation/best-practices#match-specificity-to-fragility))

**Published fact — procedures, not answers.** "A skill should teach the agent *how to approach* a class of problems, not *what to produce* for a specific instance." ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#favor-procedures-over-declarations))

**Published fact — concrete examples beat description.** Input/output pairs "convey the desired style and level of detail to Claude more clearly than descriptions alone." Templates beat prose descriptions of format "because agents pattern-match well against concrete structures." ([best practices, Examples pattern](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#examples-pattern), [agentskills best practices](https://agentskills.io/skill-creation/best-practices#templates-for-output-format))

**Published fact — one term per concept.** Pick one and hold it: always "API endpoint", never a mix of "URL / API route / path"; always "extract", never a mix of "pull / get / retrieve". "Consistency helps Claude parse and follow instructions." ([best practices, Use consistent terminology](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#use-consistent-terminology))

**Published fact — the highest-value content is gotchas.** "environment-specific facts that defy reasonable assumptions… not general advice ('handle errors appropriately') but concrete corrections to mistakes the agent will make without being told otherwise." Example given: a table with soft deletes where queries must include `WHERE deleted_at IS NULL`. And: "When an agent makes a mistake you have to correct, add the correction to the gotchas section." ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#gotchas-sections))

**Published fact — structural patterns worth reusing:** copy-able checklists for multi-step workflows; validation loops (do work → run validator → fix → repeat, where the "validator" may be a script *or* a reference document to check against); plan-validate-execute for batch or destructive operations, with a machine-checkable intermediate artifact; conditional branching at explicit decision points. ([best practices, Workflows and feedback loops](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#workflows-and-feedback-loops), [agentskills best practices](https://agentskills.io/skill-creation/best-practices#patterns-for-effective-instructions))

**Published fact — test across models.** "What works perfectly for Opus might need more detail for Haiku." The checklist asks for testing with Haiku, Sonnet, and Opus. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#test-with-all-models-you-plan-to-use))

---

## 6. Documented anti-patterns

Each of these is named as a failure mode in a first-party source.

| Anti-pattern | Source |
| --- | --- |
| **Vague description.** `Helps with documents` / `Processes data` / `Does stuff with files`. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#writing-effective-descriptions) |
| **Vague or generic name.** `helper`, `utils`, `tools`, `documents`, `data`, `files`; reserved words `anthropic`/`claude`. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#naming-conventions) |
| **Duplicating what the model already does.** "If the agent already handles the entire task well without the skill, the skill may not be adding value." | [agentskills best practices](https://agentskills.io/skill-creation/best-practices#add-what-the-agent-lacks-omit-what-it-knows) |
| **Explaining common knowledge.** Teaching what a PDF is, how HTTP works, what a migration does. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#concise-is-key) |
| **Over-long / exhaustive SKILL.md.** "Overly comprehensive skills can hurt more than they help — the agent struggles to extract what's relevant and may pursue unproductive paths triggered by instructions that don't apply." | [agentskills best practices](https://agentskills.io/skill-creation/best-practices#aim-for-moderate-detail) |
| **Time-sensitive content.** "If you're doing this before August 2025, use the old API" — put superseded material in a collapsed "Old patterns" section instead. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-time-sensitive-information) |
| **A menu instead of a default.** "You can use pypdf, or pdfplumber, or PyMuPDF, or pdf2image, or…" Give one default plus a named escape hatch. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-offering-too-many-options) |
| **Inconsistent terminology** for the same concept. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#use-consistent-terminology) |
| **Nested reference chains.** SKILL.md → advanced.md → details.md causes partial reads. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-deeply-nested-references) |
| **Windows-style paths.** `scripts\helper.py` breaks on Unix. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-windows-style-paths) |
| **Assuming packages are installed.** State the install step. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-assuming-tools-are-installed) |
| **Unqualified MCP tool names.** Use `ServerName:tool_name` or Claude may fail to locate the tool. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#mcp-tool-references) |
| **Scripts that defer to Claude.** Handle `FileNotFoundError`/`PermissionError` in the script rather than failing and letting the model improvise. | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#solve-dont-defer) |
| **Voodoo constants.** `TIMEOUT = 47 # Why 47?` — "If you don't know the right value, how will Claude determine it?" | [best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#solve-dont-defer) |
| **Wrong scope.** Too narrow forces several skills to load at once "risking overhead and conflicting instructions"; too broad becomes hard to activate precisely. | [agentskills best practices](https://agentskills.io/skill-creation/best-practices#design-coherent-units) |
| **Generic LLM-generated content.** Asking an LLM to write a skill without domain context yields "handle errors appropriately, follow best practices" filler. | [agentskills best practices](https://agentskills.io/skill-creation/best-practices#start-from-real-expertise) |
| **Over-constraining.** "If pass rates plateau despite adding more rules, the skill may be over-constrained — try removing instructions and see if results hold or improve." | [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills#iterating-on-the-skill) |
| **Overfitting the description to eval keywords.** "Avoid adding specific keywords from failed queries… find the general category those queries represent." | [optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#the-optimization-loop) |
| **`context: fork` on a reference-only skill.** "the subagent receives the guidelines but no actionable prompt, and returns without meaningful output." | [Claude Code skills](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent) |
| **Surprising or malicious content.** "A skill's contents should not surprise the user in their intent if described." Skills should be used only from trusted sources; `allowed-tools` in a project skill can grant itself broad tool access. | [skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md), [Skills overview, Security](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview#security-considerations) |

**Published fact — the shipped checklist.** Anthropic publishes a pre-release checklist: description specific and includes key terms; description covers what *and* when; body under 500 lines; details in separate files; no time-sensitive info; consistent terminology; concrete examples; references one level deep; workflows have clear steps; scripts solve rather than defer; no voodoo constants; forward slashes; **at least three evaluations created**; tested with Haiku, Sonnet, and Opus. ([best practices, Checklist](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#checklist-for-effective-skills))

---

## 7. Evaluation

### 7.1 Two failure modes, two tests

**Published fact:** "Seeing a skill trigger tells you Claude found it, not that it did what you intended. To know a skill is working, measure two things separately: whether Claude invokes it on the prompts it should, and whether the output matches what you expect when it does." ([Claude Code skills](https://code.claude.com/docs/en/skills#evaluate-and-iterate-on-a-skill))

**Published fact:** Both use baseline comparison — run each prompt in a fresh session with the skill and again with it disabled. "A fresh session matters because leftover context from authoring the skill will mask gaps in the written instructions." ([Claude Code skills](https://code.claude.com/docs/en/skills#evaluate-and-iterate-on-a-skill))

### 7.2 Triggering evals

**Published fact:** Build ~20 labelled queries, 8–10 `should_trigger: true` and 8–10 `false`. Run each 3 times (model behaviour is nondeterministic) and compute a trigger rate; pass threshold 0.5. Split 60% train / 40% validation, keep the split fixed, use *only* train failures to guide edits, and select the best iteration by **validation** pass rate — "the best description may not be the last one you produced." Five iterations is usually enough; if it isn't improving, the queries may be the problem. ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions))

**Published fact:** Query realism is the whole game. Negative cases must be **near-misses** that share keywords but need something else; `"Write a fibonacci function"` as a negative for a PDF skill "is too easy — it doesn't test anything." Positive cases must include ones where the connection isn't obvious from the query, since "if the query already asks for exactly what the skill does, any reasonable description would trigger." Queries should carry file paths, personal context, column names, casual language and typos. ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#designing-trigger-eval-queries), [skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md))

### 7.3 Output-quality evals

**Published fact:** Start with 2–3 test cases in `evals/evals.json` inside the skill directory — prompt, expected output, optional input files. Write **assertions after** seeing the first outputs, "you often don't know what 'good' looks like until the skill has run." Good assertions are objectively verifiable ("The output file is valid JSON", "The chart shows exactly 3 months"); weak ones are vague ("The output is good") or brittle (exact-phrase matching). Grade PASS/FAIL with quoted evidence into `grading.json`; aggregate pass rate, time and tokens per configuration into `benchmark.json` with a `delta`. ([evaluating skills](https://agentskills.io/skill-creation/evaluating-skills), [best practices, Build evaluations first](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#build-evaluations-first))

**Published fact:** The delta is the decision. "A skill that adds 13 seconds but improves pass rate by 50 percentage points is probably worth it. A skill that doubles token usage for a 2-point improvement might not be." ([evaluating skills](https://agentskills.io/skill-creation/evaluating-skills#aggregating-results))

**Published fact — analysis rules:** remove assertions that pass in both configurations (they inflate the score without measuring the skill); investigate assertions that fail in both (broken assertion or too-hard case); study assertions that pass only with the skill to learn *why*; treat high variance across runs as ambiguous instructions. ([evaluating skills](https://agentskills.io/skill-creation/evaluating-skills#analyzing-patterns))

**Published fact — read transcripts, not just outputs.** "If the agent wastes time on unproductive steps, common causes include instructions that are too vague…, instructions that don't apply to the current task…, or too many options presented without a clear default." And if several test runs each independently wrote the same helper script, bundle it in `scripts/`. ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#refine-with-real-execution), [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills#iterating-on-the-skill))

### 7.4 Tooling

**Published fact:** `skill-creator` is Anthropic's first-party skill for authoring, evaluating, benchmarking, blind A/B comparison, description optimization, and packaging. It exists both in [`anthropics/skills`](https://github.com/anthropics/skills/tree/main/skills/skill-creator) and as an installable Claude Code plugin: `/plugin install skill-creator@claude-plugins-official` (add the marketplace with `/plugin marketplace add anthropics/claude-plugins-official` if it isn't found), then `/reload-plugins`. It stores cases in `evals/evals.json`, spawns a subagent per case for clean context, records tokens and duration, grades into `grading.json`, aggregates into `benchmark.json`, and runs blind version A/B plus a description-tuning loop. ([Claude Code skills, Run evals with skill-creator](https://code.claude.com/docs/en/skills#run-evals-with-skill-creator))

**Published fact:** Claude Code diagnostics: `/doctor` estimates the skill listing's context cost and its biggest contributors; `--debug` surfaces frontmatter parse errors and listing-overflow warnings; the Skills row in `/context` reports post-budget listing size. If frontmatter YAML is malformed, "Claude Code loads the skill body with empty metadata, so `/skill-name` still works but Claude has no `description` to match against" — the skill silently stops auto-triggering. ([Claude Code skills, Troubleshooting](https://code.claude.com/docs/en/skills#troubleshooting))

**Published fact:** Iteration is a two-Claude loop: Claude A helps author, Claude B (fresh instance, skill loaded) does real work, you carry observations back to A. "Claude models understand the Skill format and structure natively. You don't need special system prompts or a 'writing skills' skill to get Claude to help create Skills." ([best practices, Develop Skills iteratively with Claude](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#develop-skills-iteratively-with-claude))

**Published fact — build evals before docs.** "Create evaluations BEFORE writing extensive documentation. This ensures your Skill solves real problems rather than documenting imagined ones." Anthropic also notes there is no built-in runner for the JSON eval format on the platform side. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#build-evaluations-first))

---

## 8. Where Anthropic's practice diverges from Anthropic's guidance

**Observation.** Read `github.com/anthropics/skills` as the counterweight to the docs:

| Stated guidance | What the repository actually does |
| --- | --- |
| "Consider using **gerund form** (verb + -ing) for Skill names": `processing-pdfs`, `analyzing-spreadsheets` ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#naming-conventions)) | **Zero** of the 17 public skills use a gerund name. They are nouns and noun phrases: `pdf`, `docx`, `xlsx`, `pptx`, `canvas-design`, `brand-guidelines`, `mcp-builder`, `webapp-testing`, `skill-creator`, `theme-factory`. |
| "**Always write in third person**… Avoid: 'You can use this to process Excel files'" | The four flagship document skills open imperatively: `Use this skill whenever the user wants to…`. `internal-comms` opens in the *user's* first person. |
| Keep `SKILL.md` under 500 lines | `claude-api` is 546 lines, `skill-creator` 485, `algorithmic-art` 404. |
| `description` max 1024 characters | `claude-api`'s description measures ~1077 characters (written as a `|-` YAML block scalar). |
| Bundled files go in `scripts/`, `references/`, `assets/` | `pdf/` keeps `forms.md` and `reference.md` at the skill root; `mcp-builder/` uses `reference/` singular; `webapp-testing/` uses `examples/`; `brand-guidelines/` bundles nothing. |
| Descriptions should be concise | `xlsx` 952 chars, `docx` 837, `pptx` 740 — deliberately keyword-dense with explicit `Do NOT trigger when…` clauses. |

**Inference:** Naming form and description person are cosmetic preferences, not mechanics — nothing in any loader depends on them. The rules that actually bind are the machine-checked ones (charset, length limits, `name` matching the directory) and the context-economics ones (metadata always loaded, body persistent, references one level deep). Treat the gerund rule as ignorable; treat the 500-line and 1024-char figures as targets you should have a reason to exceed.

---

## 9. Applying this to `skills/poppin/SKILL.md`

Current state: 93 lines, 274-character description, no bundled files, no `license`, no `compatibility`, no `allowed-tools`.

### 9.1 What it already does well

- **Description states what *and* when, with concrete triggers.** "Use when the user wants design or UX inspiration, real-world UI examples, reference screenshots, or wants to see how shipped apps present something such as onboarding, paywalls, dashboards, or empty states." That is the hybrid form the docs' own PDF example uses — a capability clause plus an imperative trigger clause naming user-side vocabulary rather than implementation. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#writing-effective-descriptions))
- **Well inside every budget.** 93 lines against a 500-line target; 274 chars against 1024. `name: poppin` is lowercase, hyphen-free, matches the parent directory, and contains no reserved word. ([specification](https://agentskills.io/specification#name-field))
- **One default command, not a menu.** `poppin find "<query>" --images --json` is declared "the command for almost every request," with narrower commands demoted to an "Other commands" block. This is exactly the "provide a default with an escape hatch" pattern. ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-offering-too-many-options))
- **A real gotchas section, inline where it belongs.** "Without `--images` every `path` is `null`" and "There is no sign-in… If a command fails, it is a network or upstream problem, not a missing credential" are precisely the environment-specific facts that defy reasonable assumption, kept in `SKILL.md` rather than a reference file. ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#gotchas-sections))
- **Concrete worked example.** The JSON result block with a real `previews[].path` beats any prose description of the output shape. ([best practices, Examples pattern](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#examples-pattern))
- **An explicit negative scope in the body.** "It does not crawl an app's full screen library and does not capture flows. If the user asks for those, say so rather than implying the catalog is exhaustive."
- **Standing instruction, correctly framed.** "**Read those image files and show them to the user.** … A table of ids is not an answer." Since Claude Code keeps the body in context all session, a standing rule beats a sequenced step. ([Claude Code skills, lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle))

### 9.2 Specific weaknesses

1. **The negative boundary is in the body, not the description — so it cannot prevent mis-triggering.** By the time the body is read, the skill has already fired. This machine has adjacent skills (`impeccable`, `web-animation-design`, and Anthropic's `frontend-design`) that own "make this UI better"; poppin owns "show me what other apps did." Nothing in the description separates them.
   *Rule violated:* "Add specificity about what the skill does *not* do, or clarify the boundary between this skill and adjacent capabilities." ([optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions#the-optimization-loop)). Anthropic's own `xlsx` and `docx` descriptions carry `Do NOT trigger when…` clauses for exactly this reason.

2. **"Locating the command" is a three-option menu presented as a fallback ladder.** The model is told to try `node bin/poppin.mjs`, then `poppin`, then `npx`, discovering the first two fail by running them. The skill then admits "Option 3 always works."
   *Rule violated:* "Don't present multiple approaches unless necessary… Provide a default with an escape hatch." ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-offering-too-many-options)). The transcript symptom this produces is named explicitly: "the agent tries several approaches before finding one that works." ([agentskills best practices](https://agentskills.io/skill-creation/best-practices#refine-with-real-execution))

3. **Branch 1 of that ladder is close to dead.** The skill's source lives at `skills/poppin/`, and the repo has no `.claude/skills/` directory — so inside this repo the skill is not auto-discovered by Claude Code at all. It reaches a user by being copied out (`npx skills add hoangvu12/poppin`, per `README.md`), at which point "the working directory is the poppin repo itself" is a rare coincidence. **(Observation.)** ([Claude Code skills, Where skills live](https://code.claude.com/docs/en/skills#where-skills-live))

4. **Hard-coded catalog statistics will rot.** "roughly four per app, across about 900 iOS and 470 web apps" and "a couple of seconds and a megabyte or two" are point-in-time facts baked into a document that is never re-derived. The skill already ships `poppin stats`, which reports the live figure.
   *Rule violated:* "Don't include information that will become outdated." ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#avoid-time-sensitive-information))

5. **Terminology drifts across four words for two concepts.** "screens", "screenshots", "images", "previews", "screen rows" are used interchangeably for the artifact; `find` returns "apps" while `search` returns "screen rows" — a distinction stated once, in a code comment, with no guidance on when to prefer `search`.
   *Rule violated:* "Choose one term and use it throughout… Consistency helps Claude parse and follow instructions." ([best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#use-consistent-terminology))

6. **No `allowed-tools`, so every run costs a permission prompt.** Claude Code supports pre-approving the exact command the body tells the model to run, and substitutes `${CLAUDE_SKILL_DIR}` inside the rule so it matches wherever the skill is installed. Caveat: the field is Experimental in the spec, and in Claude Code the grant lasts only the invoking turn. ([Claude Code skills, Pre-approve tools](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill), [specification](https://agentskills.io/specification#allowed-tools-field))

7. **`compatibility` is unset on a skill that genuinely has requirements.** poppin needs Node and live network access, and the spec earmarks that field for exactly "required system packages, network access needs." This is one of the minority of skills where the field applies. `license` is likewise absent, where nearly every skill Anthropic publishes carries one. ([specification](https://agentskills.io/specification#compatibility-field))

8. **The CLI is not bundled, and the skill pays for that in prose.** Sections 2 and 3 above exist only because `bin/poppin.mjs` is not reachable from the skill directory. Anthropic's guidance is the opposite: bundle the deterministic part in `scripts/`, invoke it by `${CLAUDE_SKILL_DIR}/scripts/...`, and let its code stay out of context. A thin wrapper script under `skills/poppin/scripts/` would delete "Locating the command" entirely. ([best practices, Provide utility scripts](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#provide-utility-scripts), [Claude Code skills](https://code.claude.com/docs/en/skills#available-string-substitutions))

9. **No evals exist.** No `evals/` directory, no trigger query set, no with-skill/without-skill baseline. Given point 1, the triggering set is the higher-value of the two: ~20 queries, 8–10 near-miss negatives drawn from the adjacent design skills, 3 runs each.
   *Rule violated:* the shipped checklist requires "At least three evaluations created" before sharing a skill. ([best practices, Checklist](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices#checklist-for-effective-skills))

10. **Minor: two rules assert without explaining.** "do not build one by pointing `POPPIN_IMAGE_DIR` into their project unless they ask" and "skip `--images` only when you genuinely do not need the pictures" state a constraint without the reasoning that would let the model generalise to an unanticipated case.
    *Rule:* "Explain the *why* behind everything you're asking the model to do… Models follow instructions more reliably when they understand the purpose." ([skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md), [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills#iterating-on-the-skill))

### 9.3 Priority

**Inference**, ordered by expected effect per unit of work: (1) add a negative boundary to the description and measure it with a trigger eval set — it is the only change that affects whether the skill runs at all; (2) collapse "Locating the command" to a single default, ideally by bundling a wrapper script; (3) replace hard-coded catalog numbers with a pointer to `poppin stats`; (4) fix terminology; (5) add `allowed-tools`, `license`, `compatibility`.

---

## What could not be verified

- **The exact prompt/format Claude sees for the skill listing.** The docs describe it (name + description, budgeted at ~1% of the context window, per-entry cap 1,536 chars in Claude Code) but do not publish the literal system-prompt text. Claims about how to "game" the listing are unverifiable.
- **Whether the ~100-tokens-per-skill and "under 5k tokens" figures are enforced or advisory.** They appear in a cost table, not as validation rules. The only limits any published validator enforces are the frontmatter charset and length constraints. ([specification, Validation](https://agentskills.io/specification#validation))
- **Whether third-person phrasing measurably improves discovery.** Anthropic asserts that inconsistent point-of-view "can cause discovery problems," with no published measurement, and its own shipped skills do not follow the rule. Treat it as a style preference until a trigger eval on your own skill says otherwise.
- **Gerund naming.** Documented as a suggestion ("Consider using…"), contradicted by 17 of 17 public Anthropic skills. No mechanism depends on it.
- **`allowed-tools` semantics across clients.** The spec calls it Experimental and says support varies; only Claude Code's behaviour (turn-scoped grant, `${CLAUDE_SKILL_DIR}` substitution, project-trust gate) is documented in detail.
- **Whether the platform docs' "use MUST language" advice or `skill-creator`'s "ALL CAPS is a yellow flag" advice wins.** Both are first-party and they point in opposite directions; neither cites a measurement.
- **Anything about `.skill` packaging beyond `skill-creator`'s `scripts/package_skill.py`.** No published format specification for the archive was found.
- **Community folklore not found in any primary source, and therefore dropped:** claims that skill descriptions must begin with a specific verb form; that a fixed number of trigger keywords is optimal; that `SKILL.md` must use particular heading names; that skills are ranked by embedding similarity. None of these appear in Anthropic documentation, the specification, or the public skill repository.

---

## Primary sources

- [Agent Skills overview — platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) (redirect target of docs.claude.com)
- [Skill authoring best practices — platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Extend Claude with skills — Claude Code docs](https://code.claude.com/docs/en/skills)
- [Equipping agents for the real world with Agent Skills — Anthropic engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Agent Skills specification — agentskills.io](https://agentskills.io/specification)
- [Agent Skills overview / open standard — agentskills.io](https://agentskills.io/)
- [Best practices for skill creators — agentskills.io](https://agentskills.io/skill-creation/best-practices)
- [Optimizing skill descriptions — agentskills.io](https://agentskills.io/skill-creation/optimizing-descriptions)
- [Evaluating skill output quality — agentskills.io](https://agentskills.io/skill-creation/evaluating-skills)
- [anthropics/skills repository](https://github.com/anthropics/skills)
- [skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
- [pdf](https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md), [docx](https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md), [xlsx](https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md), [pptx](https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md), [webapp-testing](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md), [internal-comms](https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md) SKILL.md files
- [skills-ref validator](https://github.com/agentskills/agentskills/tree/main/skills-ref)
- [skill-creator plugin — claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator)
