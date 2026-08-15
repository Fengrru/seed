# Security Policy

Seed runs tools on your machine — including arbitrary shell commands — on behalf of a
language model. Treat running it like giving the model a shell on the machine it runs on.

## Reporting a vulnerability

Report security issues privately through GitHub's Security Advisories feature (Security →
Advisories → Report a vulnerability). Do not open a public issue for security bugs.

## Security model

The intended boundaries, in brief:

- **Trust levels.** Tools are `trusted`, `reviewed`, or `untrusted`. `SEED_CONFIRM=1` asks
  before every reviewed-or-lower call (bash, search, MCP) and fails closed on non-interactive
  stdin. Embedders can gate calls below a threshold with `approveCall`/`confirmBelowTrust`.
- **Workspace confinement.** `fs_read`/`fs_write` are confined to the workspace with
  symlink-resolved path checks (`O_NOFOLLOW` hardening on POSIX) and a 256 KB read cap.
- **Evidence.** Every event is content-hashed; knowledge citations are verified at write
  time, and `memory revoke` stales an entry and everything derived from it.
- **Skill verification.** Distilled skills start `draft` and only become injectable after
  their verification command passes. Verification commands never run automatically unless
  `SEED_AUTO_VERIFY_SKILLS=1` is set explicitly.
- **Known trade-offs.** `bash` is intentionally unrestricted inside the workspace — run Seed
  only in an environment you would give the model a shell in. Enabling
  `SEED_LOG_RETENTION_DAYS` prunes the event log and breaks evidence citations into the
  pruned range (rows are archived to a JSONL sidecar first).
