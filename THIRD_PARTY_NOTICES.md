# Sources and attribution

This research project extends Gear and uses MoneCraft from AAArena. It is an independent project, not an official Gear release.

| Component | Upstream | Pinned base | License |
| --- | --- | --- | --- |
| Gear | https://github.com/rsi-gear/gear | `11bad082e1163d12caf2f955125d596f40b395f1` | [MIT](gear/LICENSE) |
| AAArena / MoneCraft | https://github.com/THU-CST-SAST/AAArena | `fd52d2337b6711f0f3a239216f48720c125750be` | [MIT](aaarena/LICENSE) |

Upstream copyright notices and license files are retained. Individual dependencies and bundled third-party components retain their respective licenses. The root repository does not replace those licenses or claim authorship of upstream work.

The `gear/` directory is a working-tree snapshot including our Arena extension. The `aaarena/` directory retains the upstream source and packaged game assets; install MoneCraft with its asset installer as documented in the reproduction guide. The `rsi-arena/` directory contains the website and independent runner. Nested Git metadata, installed dependencies, local credentials, private run directories, and machine caches are excluded from this source snapshot.

The README animation is an original illustration of this project's protocol, inspired by Gear's use of animated architecture diagrams. It is not copied experimental evidence. Its source is `scripts/render_architecture.py`; render it with Python and Pillow (Arial on macOS or DejaVu Sans on Linux).
