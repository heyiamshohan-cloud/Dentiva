# Generated server assets

`assets.js` in this folder is written by `bun scripts/gen-assets.mjs` during the
release build. It embeds the renderer bundle plus the Inter and Noto Sans
Bengali font files into the executable so a packaged Dentiva needs nothing but
its own `.exe`.

The file that ships in the repository is an empty stub — useful when running
from source, where assets are streamed from disk.
