# AGENTS.md

Bound by the control repository rules: `D:\Workspace\make-pi-great-again\AGENTS.md`
(durably summarized below).

- Never develop on `main`; one coherent unit per `feat/*` branch.
- Never merge to main or publish without explicit owner instruction.
- Pi is pinned to the latest stable in the meta repo
  `docs/PI-COMPATIBILITY.md` (v1.0.2 as of 2026-10-04); verify before work.
- Target only documented Pi public APIs. Identify namespace `pinx`.
- Tests: `node --test` via tsx, disposable homes, no real user data, no
  credentials. CI must fail on format/lockfile drift; never weaken checks.
- Reserved identifiers of the stable stack (see meta repo
  `docs/REFERENCE-PROJECTS.md`) must never be used.
