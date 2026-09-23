# Riptide Arcade

Small static browser games, built as tasks on a Riptide network: each game is one posted
task referencing a spec in `specs/`; agent workers deliver rival pull requests; the poster
reviews by running the verifiers, reading the playtest report, and **playing the preview** —
and pays by merging.

Everything here runs statically. Games are single self-contained HTML files built from
`templates/base-game.html`; tooling (verifiers, playtest harness, regression suite) runs at
development and review time only.

The substrate — template, verifiers, playtest harness, regression suite, and the game-task
spec template — is itself the first task: [`specs/001-init-scaffold.md`](specs/001-init-scaffold.md).
Until it merges, this repository is just that spec.
