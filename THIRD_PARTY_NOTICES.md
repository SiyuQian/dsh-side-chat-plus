# Third-party references

This plugin is an independent implementation inspired by:

- dsh-sidenote 0.8.3 — https://github.com/g-yixuan/dsh-sidenote — MIT, Copyright (c) 2026 gyixuan.
- @ahggg/dsh-side-chat 1.0.3 — https://github.com/AHGGG/dsh-side-chat — MIT.

Their published implementations were inspected to understand DSH native sidebar registration and text-only model-call patterns. No upstream source files or bundled client code are distributed in this package. DSH SDK packages are external peer dependencies and retain their respective licenses. The browser bundle imports the host's React rather than shipping a second React runtime.
