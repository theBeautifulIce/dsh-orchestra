# Contributor attribution maintenance — 2026-11-25

## Scope

The repository owner requested removal of an AI co-author credit from the default branch. One historical commit contained this trailer:

```text
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

The correction removes this exact line from commit `bd15daaeafbd3ab6f707ebe375314e7ccd3dfad5`. It does not change human author or committer identities. No other commit message changes during the history rewrite.

| Object | Before | After the metadata-only rewrite |
| --- | --- | --- |
| Main tip | `083761a7c76ef9502f4b01d837f2cece913ae4e0` | `c733195d007621857a49405b1ae418bb5d2b2519` |
| Corrected commit | `bd15daaeafbd3ab6f707ebe375314e7ccd3dfad5` | `81d97c83428e9dc66e59d4258bdbc423642f7dfd` |
| Frozen G5 commit | `8abbf0f0bc14c0a9e006625528d38e7288ccefba` | `7002439e286bad91f43405c468d4f25a646eb88e` |

The metadata-only rewrite retains all 674 commits and both merge commits. Exactly 149 commit IDs change. Every corresponding commit retains its tree, author, committer, timestamp, parent order, and unrelated message bytes. The old and rewritten tips share tree `1f6b585c08c4468926277374e84528102f381f34`.

The accompanying [commit map](2026-11-25-commit-map.json) lists all 149 changed IDs. It records the metadata-only rewrite. The maintenance commit that contains this document and the gate compatibility fix is a later commit.

## Gate compatibility

Historical gate reports and signatures retain their original commit bindings. Do not replace their SHAs or claim that they were signed again.

The gate tooling continues to read the original frozen G5 commit. It also recognizes the exact rewritten G5 commit as an ancestry anchor after checking that both commits have the same complete tree. No arbitrary equivalent-tree commit is accepted. Missing historical objects or a mismatched tree cause validation to fail.

This compatibility change applies to maintenance and release validation tools. It does not change plugin runtime code. It does not issue a new G6 approval or replace any required release evidence.

## Release preservation

Keep both published tags and all Release assets unchanged:

- `v0.1.0-beta.1` → `a076439817db2a6d1c8cd2bb22ff2f9931814b45`
- `v0.1.0-beta.2` → `083761a7c76ef9502f4b01d837f2cece913ae4e0`

These tags preserve the original release history and its evidence. They are not ancestors of the rewritten main. Use the commit map when interpreting old audit links or preparing the next release comparison. Do not infer that `git describe` on the new history must select either old release tag.

A complete clone with tags provides the historical objects required by the gate verifier. If a clone lacks them, fetch the published tags from the verified repository before running gate checks. Do not bypass a missing-object failure.

## Updating existing clones

Do not merge the old main history back into the rewritten main. That would restore the removed attribution.

Before changing a local main, save uncommitted work and create a backup of any local commits. Fetch the remote, inspect any local-only commits, and replay only intended changes onto the new main. A clean clone whose local main exactly matches the old published tip can be realigned to the verified new remote tip after creating a backup. Do not reset a dirty or divergent checkout without reviewing it.

The default branch update must use an explicit lease for the observed old remote SHA. Stop if the remote changes while this maintenance is prepared. Push only `refs/heads/main`; do not force-push tags or other refs.

## Contributor display

GitHub derives co-author credit from commit trailers. Its contributor displays can take approximately 24 hours to refresh after a history change. Verify the default branch history separately from the cached sidebar.

References:

- [GitHub: commits with multiple authors](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors)
- [GitHub: viewing contributors and stale data](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors)
- [Git: explicit force-with-lease](https://git-scm.com/docs/git-push)

For future commits, retain the actual human author. Do not add an AI co-author trailer unless the repository owner explicitly requests it.
