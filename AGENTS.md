## Agent skills

### Commit attribution

Preserve the actual human author and committer when maintaining commit history. Do not add an AI assistant as an author, committer, or `Co-Authored-By` entry unless the repository owner explicitly requests that attribution.

### Issue tracker

GitHub Issues on `theBeautifulIce/dsh-orchestra`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles at their default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus the `wayfinder:map` / `wayfinder:<type>` labels. See `docs/agents/triage-labels.md`.

### Domain docs

single-context: one root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Reliability audit

Every stage close-out is audited under the project root `审计要求.md` (《工程可靠性收敛审计规范》 plus this repo's stage scope, exit conditions, report format and cross-round issue list). Start an audit with: 请按照《工程可靠性收敛审计规范》审查我本次提交。
