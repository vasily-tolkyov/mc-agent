# Historical source, audit only

Box-world / experiment-bench era of mc-agent (before the `mind-agent.mjs` line). Nothing here is a supported launch command.

- `interactive-agent.cjs`, `concept-agent.cjs`, `live-agent.cjs`: byte-preserved copies of the three former MC entrypoints (see `original-hashes.json`). They imported energy-network-sim's `TransitionMemory`, used browser viewers, and relied on privileged experimental resets (`/tp`, `/give`, `/fill`) through `mc-bench.cjs`, which now sits next to them again so their historical relative paths resolve.
- `server/`: the 1.20.x flat server + world these entrypoints ran against (port 25565, creative). The current line uses the 1.21.4 training ground managed by `scripts/local-server.mjs` (`.local-minecraft/`, port 25567) and is unrelated to this folder.
- `verify-rule-engine.mjs`: capacity regression of energy-network-sim's sample-registration `TransitionMemory` (the rule memory that `mind-agent.mjs` no longer uses). Run from the repository root with `ENS_PATH` or a sibling `../energy-network-sim` clone: `node legacy/box-world/verify-rule-engine.mjs`.
- Do not relabel `exploration-episodes.json` as an ExperienceSession checkpoint or as `runs/mind-episodes.jsonl` input.
