# Review Loop Volt extension

Run iterative review/fix cycles in isolated context windows.

## Install

From the Volt store:

```text
/store install review-loop
```

Or install the package source directly:

```bash
volt install git:https://github.com/volt-hq/Volt@store/review-loop
```

## Usage

```text
/review-loop        # up to maxLoops (5) loops, review current branch vs baseBranch or the detected base
/review-loop 5      # explicit loop limit
/review-loop main   # review current branch vs main
/review-loop 3 main # up to 3 loops vs main
```

The extension refuses to start unless the git working tree is clean. Each loop:

1. Reviews the cumulative branch diff (`base...HEAD`) in a separate Volt process.
2. Fixes all findings in a fresh separate Volt process.
3. Commits the fix work with a documented `review/work: iteration N` commit.
4. Reviews the cumulative branch diff again, including previous loop commits.

The loop stops when a review reports no findings, a phase fails, no fix changes are produced, or the loop limit is reached.

While it runs, a panel above the editor and the footer status show the loop's iteration and phase.

## Settings

Edit the settings from `/extensions` (or `volt config`), or in `settings.json` under `extensions.review-loop.settings`. Arguments override them for one run.

| Setting | Default | Description |
|---------|---------|-------------|
| `maxLoops` | `5` | Review/fix cycles a run makes at most, 1 to 50 |
| `baseBranch` | detected | Ref the branch diff is taken against; unset detects `origin/HEAD`, else `origin/main`, `main`, `origin/master`, or `master` |
