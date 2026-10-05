# Technical Debt Register — a Spec Kit extension

Spec Kit ships extensions for assessing an idea (`assess`), triaging a bug (`bug`), and driving git
(`git`). It has nothing for the third thing every codebase accumulates: **the shortcuts it is
already carrying.** This extension is that register.

It gives you three commands and one directory per debt:

```text
.specify/debt/
├── review.md                     # written by debt.review — a snapshot of now
└── n-plus-one-invoices/
    ├── debt.md                   # written by debt.log   — the entry
    └── payment.md                # written by debt.pay   — how it was paid
```

| Command | What it does | Touches source? |
| --- | --- | --- |
| `/speckit.debt.log` | Records a shortcut as an entry: where it lives, what it costs, what paying it looks like. | No |
| `/speckit.debt.review` | Re-checks open entries against the current tree — still there, moved, gone, or spread. | No |
| `/speckit.debt.pay` | Verifies the exit condition is genuinely met, then closes the entry with the evidence. | No |

## Why none of them writes code

Paying a debt is an ordinary change: it gets a spec or a lite-path fix, a test, and a PR, like any
other work. If the register could also perform the fix, the two would blur, and entries would start
closing because the model believed the work was done rather than because the tree showed it.

So the register only ever reads code and writes inside `.specify/debt/`. `debt.pay` reaches a verdict
of `verified`, `partial`, `unpaid` or `not-run`, and **only `verified` closes an entry**. A test that was not
executed is `not-run`, however obvious its result — the same discipline the `bug` extension applies to
its verifications.

## What makes an entry worth keeping

Most debt files rot into a list of adjectives. An entry here is required to carry three things a
future reader cannot reconstruct alone:

- **Anchors** — `path/to/file.ts:42` or `path/to/file.ts::functionName`, at least one, grounded in
  code that actually exists. Without an anchor the entry can never be reviewed, so `debt.log` refuses
  to write one.
- **Interest** — what it costs while unpaid, stated observably ("every new provider needs the same
  40-line copy"), not aesthetically ("this is ugly").
- **A trigger** — the condition that turns it from tolerable into urgent. A debt with no trigger is
  never scheduled by anyone.

Severity is assigned from the interest, not from how the code looks.

`debt.review` exists because the anchors are what rot first. It reports entries as `still-open`,
`drifted`, `likely-paid`, `grown` or `malformed` — and `grown` (the pattern now appears in more
places than the entry lists) is the finding that usually justifies the whole exercise.

## Install

From a Spec Kit project, install it the way a published extension is installed — from a release-shaped
archive. Until the extension has its own repository and release, build the archive locally and serve
it over localhost (the CLI accepts `https://` and localhost `http://` only):

```sh
# from the repository root
d=$(mktemp -d) && cp -r tools/spec-kit-debt "$d/spec-kit-debt-1.0.0" \
  && (cd "$d" && python3 -c "import shutil; shutil.make_archive('spec-kit-debt-1.0.0','zip','.','spec-kit-debt-1.0.0')") \
  && (python3 -m http.server 8765 --bind 127.0.0.1 --directory "$d" & sleep 1 \
      && specify extension add debt --from http://localhost:8765/spec-kit-debt-1.0.0.zip; kill %1)
specify extension list
```

`specify extension add --dev tools/spec-kit-debt` also works and is the right tool while **editing** the
extension — it refreshes on every reinstall — but it registers the agent skills as **symlinks into a
generated cache** (`.specify/extensions/debt/.specify-dev/`) rather than as files. That cache is build
output and is not committed, so a dev install must not be what lands in git: on a fresh clone the
symlinks would point at nothing and the skills would silently not exist. Iterate with `--dev`, then
reinstall from the archive before committing.

With the Claude integration the commands register as the skills `speckit-debt-log`,
`speckit-debt-review` and `speckit-debt-pay`, invoked as `/speckit-debt-log` and so on. Other agents
get their own invocation syntax — the command bodies use Spec Kit's agent-neutral
`__SPECKIT_COMMAND_*__` tokens rather than hard-coded slash commands.

Each command declares an `argument-hint` in its frontmatter (the autocomplete hint Claude Code shows
after `/speckit-debt-log`). Spec Kit 1.0.x carries that key into a generated skill only on one of its
two skill-rendering paths, and a dev install of an extension takes the other, so the hint is absent
from the generated `SKILL.md` today. It costs nothing to keep declared: a Spec Kit release that
unifies the two paths will pick it up without a change here.

To remove it:

```sh
specify extension remove debt
```

## Usage

```sh
/speckit-debt-log the invoice list issues one query per row; we shipped it for the deadline
/speckit-debt-log slug=n-plus-one-invoices the invoice list issues one query per row

/speckit-debt-review                       # every open entry
/speckit-debt-review slug=n-plus-one-invoices

/speckit-debt-pay slug=n-plus-one-invoices paid by #204
```

`debt.log` resolves the slug from your input, or asks for one, or generates a unique one when nobody
is there to ask — and never overwrites an existing entry. Name the debt, not the fix:
`n-plus-one-invoices`, not `add-index`. The name outlives the plan.

## Optional: log debt at the end of an implementation

The moment you actually know what was traded away is the moment the feature lands. This extension
ships **no hooks**, deliberately — a prompt on every `/speckit.implement` is intrusive, and a hook
that fires automatically is worse. If you want it, add it to your project's `.specify/extensions.yml`
by hand:

```yaml
hooks:
  after_implement:
    command: "speckit.debt.log"
    optional: true
    prompt: "Record any technical debt this introduced?"
```

Check your project's `settings.auto_execute_hooks` before you do: with it enabled, an `optional` hook
may run without prompting.

## Before publishing this to the Spec Kit catalog

Per the [Extension Publishing Guide](https://github.com/github/spec-kit/blob/main/extensions/EXTENSION-PUBLISHING-GUIDE.md),
three things are still open, and each is the owner's call rather than something to default:

1. **A license.** The guide requires a `LICENSE` file (MIT or Apache 2.0 are the usual choices) and a
   `license` field in `extension.yml`. Both are deliberately absent here — the parent repository
   declares no license, so this extension inherits that ambiguity until someone decides.
2. **Its own repository.** The catalog entry wants a standalone repo (`spec-kit-debt`) and a tagged
   GitHub release; the download URL is the release archive. This directory is already shaped to be
   moved out wholesale — update `repository` and `homepage` in `extension.yml` when it is.
3. **The submission itself.** Community extensions are added by filing an
   [Extension Submission issue](https://github.com/github/spec-kit/issues/new?template=extension_submission.yml)
   against `github/spec-kit` — never by a pull request to the catalog file. Maintainers check the
   metadata and the download URL; they do not review the code.

## Layout

```text
spec-kit-debt/
├── extension.yml
├── README.md
├── CHANGELOG.md
├── .extensionignore              # what stays out of the installed copy: evals/, .gitignore
├── .gitignore
├── commands/
│   ├── speckit.debt.log.md
│   ├── speckit.debt.review.md
│   └── speckit.debt.pay.md
└── evals/                        # one evals.json per skill: realistic prompts + verifiable expectations
    ├── speckit-debt-log/
    ├── speckit-debt-review/
    └── speckit-debt-pay/
```

The `evals/` cases are the skill-authoring practice of testing a skill against real prompts rather than
reading it: each file lists what a user would actually type and what the skill is expected to do —
including the refusals (a vague "this is messy" gets no entry; a bug is redirected; a `pay` with no
slug and nobody to ask stops instead of guessing).
