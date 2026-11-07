# Third-party notices

Cloude 2.0 includes Paseo, copyright Mohamed Boudra and contributors, under Apache License 2.0, together with its dependencies under their respective licenses.

The exact source revision and package versions are pinned in `paseo-lock.json`. `scripts/prepare-paseo.cjs` fetches and builds those sources and applies the Cloude integration. The installed `resources/paseo` directory includes the upstream license and runtime package metadata.

Source repository: https://github.com/getpaseo/paseo

Cloude adaptations cover installation identity, application data isolation, bundled runtime paths, daemon version matching, release updates and access to the existing Cloude SSH workspace. Paseo source retains upstream attribution.

The cdesktop, sublodex and claude-mirror projects informed the research and acceptance criteria. Any future incorporation of their code requires recording its source revision and applicable license here.
