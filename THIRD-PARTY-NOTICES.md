# Third-Party Notices

Volt uses third-party software under its own license terms. The authoritative
versioned dependency inventory for the npm CLI is
`packages/coding-agent/npm-shrinkwrap.json`; npm-installed dependencies retain
the license files shipped in their own packages.

The standalone binary archive additionally redistributes or embeds the
following components. This list is intentionally explicit because those files
are shipped inside one Volt archive rather than installed as separate npm
packages.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Bun runtime | 1.3.10 | MIT; embedded JavaScriptCore/WebKit portions are LGPL-2.0 | https://bun.sh/docs/project/license |
| `@silvia-odwyer/photon-node` / `photon_rs_bg.wasm` | 0.3.4 | Apache-2.0 | https://github.com/silvia-odwyer/photon |
| `clipboard-image` / `run-jxa` | 0.1.0 / 3.0.0 | MIT | https://github.com/sindresorhus/clipboard-image |
| `highlight.js` npm module / vendored browser bundle | 10.7.3 / 11.9.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| `marked` npm module / vendored browser bundle | 18.0.5 | MIT | https://github.com/markedjs/marked |

Exact locally available license texts for Photon, clipboard-image, run-jxa,
Highlight.js, and Marked are included under `dist/LICENSES/` in the npm package
and `LICENSES/` in each standalone archive. Those files are copied byte-for-byte
from the pinned npm dependencies during the release build.

The binary also embeds the JavaScript dependency closure represented by the
shrinkwrap inventory. Its per-package SPDX identifiers and immutable registry
integrity hashes are recorded there.

The native `@number0/iroh` adapter is an optional dependency of the npm
distribution under `MIT OR Apache-2.0`. It is intentionally **not** included in
the standalone Bun binary, which consequently cannot host `volt daemon` or
provide remote/iOS access.

## Bun / JavaScriptCore redistribution

Bun's published licensing documentation states that Bun itself is MIT and
that it statically links JavaScriptCore/WebKit portions under LGPL-2.0. It also
publishes the patched WebKit source and relinking instructions at:

- https://bun.sh/docs/project/license
- https://github.com/oven-sh/webkit
- https://github.com/oven-sh/bun

This notice is not a substitute for the applicable license texts or a release
owner's compliance review. Before public binary distribution, preserve the
corresponding source/relinking materials required for the exact Bun release.
