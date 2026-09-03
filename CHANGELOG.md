## [0.8.0-beta.6](https://github.com/RbBtSn0w/adg/compare/0.8.0-beta.5...0.8.0-beta.6) (2026-09-03)

### Added

* **marketing:** add ADG Cloudflare Pages homepage ([#98](https://github.com/RbBtSn0w/adg/issues/98)) ([f061d0c](https://github.com/RbBtSn0w/adg/commit/f061d0cf6fd20961bf6af295d44e2f7f9d7816b3))

## [0.8.0-beta.5](https://github.com/RbBtSn0w/adg/compare/0.8.0-beta.4...0.8.0-beta.5) (2026-09-03)

### Added

* **skills:** sync vendor with upstream v1.5.23 ([#97](https://github.com/RbBtSn0w/adg/issues/97)) ([61d1ec4](https://github.com/RbBtSn0w/adg/commit/61d1ec4cee3a4630781d77143a7d1dee12d490eb))

## [0.8.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.8.0-beta.3...0.8.0-beta.4) (2026-09-03)

### Fixed

* **deps:** remediate Dependabot security alerts ([#96](https://github.com/RbBtSn0w/adg/issues/96)) ([55620cc](https://github.com/RbBtSn0w/adg/commit/55620cc95f4e8e1c5aec193ccec686b906440afb))

## [0.8.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.8.0-beta.2...0.8.0-beta.3) (2026-09-02)

### Added

* **projection:** rewire agents/antigravity.ts onto the projection-slot pipeline (Phase 3 of [#85](https://github.com/RbBtSn0w/adg/issues/85) finding [#1](https://github.com/RbBtSn0w/adg/issues/1)) ([#95](https://github.com/RbBtSn0w/adg/issues/95)) ([c5d7597](https://github.com/RbBtSn0w/adg/commit/c5d7597d88864295941024f99f372423cc928a34))

## [0.8.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.8.0-beta.1...0.8.0-beta.2) (2026-09-02)

### Added

* **projection:** add observeSlot/applySlotAction IO layer (Phase 2 of [#85](https://github.com/RbBtSn0w/adg/issues/85) finding [#1](https://github.com/RbBtSn0w/adg/issues/1)) ([6b4625b](https://github.com/RbBtSn0w/adg/commit/6b4625ba020fa02e939bd39cc66151b0b3481549))

### Fixed

* **projection:** give removeOwned a clear refusal for a plain file, not a raw ENOTDIR ([98878a9](https://github.com/RbBtSn0w/adg/commit/98878a905d310e475c73be3f2ab0d626fe185c81))
* **projection:** guard the copy-fallback against pre-existing content and write the ownership marker before copying ([0ec3c85](https://github.com/RbBtSn0w/adg/commit/0ec3c8585003349c737eba10aa350f8e382851f5))
* **projection:** rethrow non-ENOENT stat failures in the slot IO layer ([26e9785](https://github.com/RbBtSn0w/adg/commit/26e9785c772605f1d4552530ba53ed463fcf9633))
* **projection:** stop existsSync-swallowed errors from misreporting broken links, harden the ownership marker, and re-check before deleting ([fb21d1b](https://github.com/RbBtSn0w/adg/commit/fb21d1b44d5d162a882c640fc99d0a712c07da0d))
* **projection:** stop the marker from being clobbered or spoofed ([1734fc0](https://github.com/RbBtSn0w/adg/commit/1734fc0f68b454887d95f53c49addb2a93ddf464))

### Changed

* **projection:** correct observeSlot's doc comment to mention the marker read ([3fda86f](https://github.com/RbBtSn0w/adg/commit/3fda86ff8d89cab21df9aa88c2c1d86f84890718))

## [0.8.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.7.2-beta.2...0.8.0-beta.1) (2026-09-02)

### Added

* **projection:** add pure projection-slot decision model (Phase 1 of [#85](https://github.com/RbBtSn0w/adg/issues/85) finding [#1](https://github.com/RbBtSn0w/adg/issues/1)) ([195b49f](https://github.com/RbBtSn0w/adg/commit/195b49fa0290bb99ea949a53ed96f5cff87d365c))

### Fixed

* **projection:** distinguish confirmed-absent from foreign-blocked-removal ([08092dd](https://github.com/RbBtSn0w/adg/commit/08092dd6005c80c07afcea9fbda72e8d9a8f236d))
* **projection:** stop assertNever from leaking a full state object ([32ce252](https://github.com/RbBtSn0w/adg/commit/32ce252015f1e6b36879b44d01f8b84e1772f351))

## [0.7.2-beta.2](https://github.com/RbBtSn0w/adg/compare/0.7.2-beta.1...0.7.2-beta.2) (2026-09-02)

### Fixed

* **antigravity:** guard the runner's entry-point check against a non-path argv[1] ([faf6f44](https://github.com/RbBtSn0w/adg/commit/faf6f440b2c8de8c8f398dfc5837707996f3096e))
* **install:** stop leaking temp dirs when prepareSource/synthesize throws ([a38fc36](https://github.com/RbBtSn0w/adg/commit/a38fc36dba41a7a195d7d435de281da5f9ddba88))
* **telemetry:** close the sanitizeArgs allowlist gap for init/adapt/aliases ([b55024f](https://github.com/RbBtSn0w/adg/commit/b55024fd37c239bbb79a2b191d0bc07b582abed9)), closes [#85](https://github.com/RbBtSn0w/adg/issues/85)
* **test:** use fileURLToPath instead of URL.pathname for the runner test path ([37a956b](https://github.com/RbBtSn0w/adg/commit/37a956b1853efd8b1d91917b74876247eb1db206))

### Changed

* **antigravity:** extract the embedded hook-runner into a real .mjs file ([8ec2334](https://github.com/RbBtSn0w/adg/commit/8ec23347091f26214224564b6453a6f61d377cfc)), closes [#85](https://github.com/RbBtSn0w/adg/issues/85)
* **cli:** share update-scope loop between `plugins update` and `marketplace upgrade` ([16d25b4](https://github.com/RbBtSn0w/adg/commit/16d25b4d338b54f61e2401a5a641c47cb22dde7a)), closes [#85](https://github.com/RbBtSn0w/adg/issues/85)
* **install:** extract prepareSource() and synthesizeDefaultDslPlugin() from addPlugins ([61cdff0](https://github.com/RbBtSn0w/adg/commit/61cdff086945d5d568de059fdf52cf6072d65bc5)), closes [#85](https://github.com/RbBtSn0w/adg/issues/85)
* **readme:** correct telemetry wording and disclose the endpoint URL ([cffb267](https://github.com/RbBtSn0w/adg/commit/cffb267a7fb1e7fe41375618663eb613f58c5afc))
* **readme:** disclose default-on telemetry and its opt-out ([4d7a82b](https://github.com/RbBtSn0w/adg/commit/4d7a82b67f8c13bb94e738c33e625fd297b82808)), closes [#85](https://github.com/RbBtSn0w/adg/issues/85)
* **readme:** fix telemetry endpoint path and sanitizeArgs depth claim ([259648a](https://github.com/RbBtSn0w/adg/commit/259648aa0451af54b8eaf06b3b715ff8119858f1))
* **readme:** fix telemetry wording to match the implementation ([0143cee](https://github.com/RbBtSn0w/adg/commit/0143cee33845abb6e0efbb6626001753c96cf8d3))
* **telemetry:** fix "two domains" doc comment listing three items ([b5f923e](https://github.com/RbBtSn0w/adg/commit/b5f923e63cd265d18004f32905cfbe77d5c4c01f))

## [0.7.2-beta.1](https://github.com/RbBtSn0w/adg/compare/0.7.1...0.7.2-beta.1) (2026-09-01)

### Fixed

* **update:** show progress instead of hanging silently ([#86](https://github.com/RbBtSn0w/adg/issues/86)) ([df4ffd4](https://github.com/RbBtSn0w/adg/commit/df4ffd46053ea585e92e13d62cc8dec4585f0456))

## [0.7.1](https://github.com/RbBtSn0w/adg/compare/0.7.0...0.7.1) (2026-08-03)

### Fixed

* **antigravity:** keep OAuth ownership in authored MCP config ([#75](https://github.com/RbBtSn0w/adg/issues/75)) ([f5cc0d1](https://github.com/RbBtSn0w/adg/commit/f5cc0d18a61d9ad5218683cae34d375a379160c4))
* **antigravity:** normalize MCP config projection ([#71](https://github.com/RbBtSn0w/adg/issues/71)) ([c6a2e9c](https://github.com/RbBtSn0w/adg/commit/c6a2e9c898b2dfb262df5aad9bd40cf609452410))
* **antigravity:** normalize unwrapped MCP server maps and preserve type field ([#73](https://github.com/RbBtSn0w/adg/issues/73)) ([1547a51](https://github.com/RbBtSn0w/adg/commit/1547a514fc53d0298590daa28955e19891bb10e9))
* **antigravity:** preserve unexpected projection directories ([147583b](https://github.com/RbBtSn0w/adg/commit/147583b51cc464184d3931ffe5fdb39d5061f8ce))
* **antigravity:** replace stale MCP projection targets ([f14ec18](https://github.com/RbBtSn0w/adg/commit/f14ec18364027470034bf7d4002a0dbfe2a0fa6b))
* **antigravity:** unlink stale MCP projection aliases ([1578f9a](https://github.com/RbBtSn0w/adg/commit/1578f9a74bae6c3099db7eba7aaab7e27fcd4457))
* **ci:** validate native stack member target refs ([#81](https://github.com/RbBtSn0w/adg/issues/81)) ([d6a16ba](https://github.com/RbBtSn0w/adg/commit/d6a16ba96dd57488ec5b144d3ad10176d9a7f7ee))
* migrate structural plugins to explicit manifests ([#72](https://github.com/RbBtSn0w/adg/issues/72)) ([1b0b6d3](https://github.com/RbBtSn0w/adg/commit/1b0b6d33d6c4ca93aafddc0133a8ba207fd2f7ab))
* **skills:** sanitize inherited git clone environment ([#70](https://github.com/RbBtSn0w/adg/issues/70)) ([3045c1e](https://github.com/RbBtSn0w/adg/commit/3045c1e0b164ba150b8e071536bc1adf2040d1d4))
* **telemetry:** handle dash-prefixed option values ([e118b4c](https://github.com/RbBtSn0w/adg/commit/e118b4cec8c9e9491940169d416714cc389f8b9c))
* **telemetry:** preserve commands after option values ([11d90bd](https://github.com/RbBtSn0w/adg/commit/11d90bdbaeb56846bd0f3da2f97294bef1c088de))
* **telemetry:** report gateway command outcomes ([#77](https://github.com/RbBtSn0w/adg/issues/77)) ([304efa7](https://github.com/RbBtSn0w/adg/commit/304efa7168d06f41705b2e5b5d19e26d76c4a927))

## [0.7.1-beta.9](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.8...0.7.1-beta.9) (2026-08-03)

### Fixed

* **antigravity:** preserve unexpected projection directories ([147583b](https://github.com/RbBtSn0w/adg/commit/147583b51cc464184d3931ffe5fdb39d5061f8ce))
* **antigravity:** replace stale MCP projection targets ([f14ec18](https://github.com/RbBtSn0w/adg/commit/f14ec18364027470034bf7d4002a0dbfe2a0fa6b))
* **antigravity:** unlink stale MCP projection aliases ([1578f9a](https://github.com/RbBtSn0w/adg/commit/1578f9a74bae6c3099db7eba7aaab7e27fcd4457))

## [0.7.1-beta.8](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.7...0.7.1-beta.8) (2026-08-02)

### Fixed

* **telemetry:** handle dash-prefixed option values ([e118b4c](https://github.com/RbBtSn0w/adg/commit/e118b4cec8c9e9491940169d416714cc389f8b9c))
* **telemetry:** preserve commands after option values ([11d90bd](https://github.com/RbBtSn0w/adg/commit/11d90bdbaeb56846bd0f3da2f97294bef1c088de))

## [0.7.1-beta.7](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.6...0.7.1-beta.7) (2026-08-02)

### Fixed

* **ci:** validate native stack member target refs ([#81](https://github.com/RbBtSn0w/adg/issues/81)) ([d6a16ba](https://github.com/RbBtSn0w/adg/commit/d6a16ba96dd57488ec5b144d3ad10176d9a7f7ee))

## [0.7.1-beta.6](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.5...0.7.1-beta.6) (2026-07-25)

### Fixed

* **telemetry:** report gateway command outcomes ([#77](https://github.com/RbBtSn0w/adg/issues/77)) ([304efa7](https://github.com/RbBtSn0w/adg/commit/304efa7168d06f41705b2e5b5d19e26d76c4a927))

## [0.7.1-beta.5](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.4...0.7.1-beta.5) (2026-07-24)

### Fixed

* **antigravity:** keep OAuth ownership in authored MCP config ([#75](https://github.com/RbBtSn0w/adg/issues/75)) ([f5cc0d1](https://github.com/RbBtSn0w/adg/commit/f5cc0d18a61d9ad5218683cae34d375a379160c4))

## [0.7.1-beta.4](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.3...0.7.1-beta.4) (2026-07-24)

### Fixed

* **antigravity:** normalize unwrapped MCP server maps and preserve type field ([#73](https://github.com/RbBtSn0w/adg/issues/73)) ([1547a51](https://github.com/RbBtSn0w/adg/commit/1547a514fc53d0298590daa28955e19891bb10e9))

## [0.7.1-beta.3](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.2...0.7.1-beta.3) (2026-07-22)

### Fixed

* migrate structural plugins to explicit manifests ([#72](https://github.com/RbBtSn0w/adg/issues/72)) ([1b0b6d3](https://github.com/RbBtSn0w/adg/commit/1b0b6d33d6c4ca93aafddc0133a8ba207fd2f7ab))

## [0.7.1-beta.2](https://github.com/RbBtSn0w/adg/compare/0.7.1-beta.1...0.7.1-beta.2) (2026-07-20)

### Fixed

* **antigravity:** normalize MCP config projection ([#71](https://github.com/RbBtSn0w/adg/issues/71)) ([c6a2e9c](https://github.com/RbBtSn0w/adg/commit/c6a2e9c898b2dfb262df5aad9bd40cf609452410))

## [0.7.1-beta.1](https://github.com/RbBtSn0w/adg/compare/0.7.0...0.7.1-beta.1) (2026-07-19)

### Fixed

* **skills:** sanitize inherited git clone environment ([#70](https://github.com/RbBtSn0w/adg/issues/70)) ([3045c1e](https://github.com/RbBtSn0w/adg/commit/3045c1e0b164ba150b8e071536bc1adf2040d1d4))

## [0.7.0](https://github.com/RbBtSn0w/adg/compare/0.6.0...0.7.0) (2026-07-15)

### Added

* add support for resolved Git revisions in DSL and plugin rendering ([ddd6a8b](https://github.com/RbBtSn0w/adg/commit/ddd6a8b28fdfd1c8806e666737040701360267fb))
* mcp selective install ([#58](https://github.com/RbBtSn0w/adg/issues/58)) ([9cdd463](https://github.com/RbBtSn0w/adg/commit/9cdd46377b52bb47025c502b3b9fb8dc80236c3d))
* Merge pull request [#68](https://github.com/RbBtSn0w/adg/issues/68) from RbBtSn0w/beta ([7bb92be](https://github.com/RbBtSn0w/adg/commit/7bb92be0b99e1ecc7e7fc67af7820d8a36ae8387))
* support structural skills repositories as plugins ([#64](https://github.com/RbBtSn0w/adg/issues/64)) ([b4160fc](https://github.com/RbBtSn0w/adg/commit/b4160fca77343525f8cead4db244202e06148b83))

### Fixed

* Bugfix ([#62](https://github.com/RbBtSn0w/adg/issues/62)) ([9db7d4a](https://github.com/RbBtSn0w/adg/commit/9db7d4ab03f719fe5c85f8f6b84e61d6c48f1e94))
* **deps:** resolve undici security advisories ([#65](https://github.com/RbBtSn0w/adg/issues/65)) ([cb3ca13](https://github.com/RbBtSn0w/adg/commit/cb3ca132923430f16f497fb9b1ec73e8bbb60876))
* harden Codex plugin cache recovery ([#63](https://github.com/RbBtSn0w/adg/issues/63)) ([77cdb3b](https://github.com/RbBtSn0w/adg/commit/77cdb3b0f9759c3ddcb074916718c4ba074f867f))
* harden plugin agent runtime integration ([#57](https://github.com/RbBtSn0w/adg/issues/57)) ([be23048](https://github.com/RbBtSn0w/adg/commit/be2304818ff88aef6273e3f44f7ff8685a6941fb))
* report skills update entrypoint failures ([#60](https://github.com/RbBtSn0w/adg/issues/60)) ([6af4eeb](https://github.com/RbBtSn0w/adg/commit/6af4eeb1ec44a6edc8a30a53c4f4e406485f0875))

### Changed

* Enhance OpenTelemetry compliance and improve error handling ([#59](https://github.com/RbBtSn0w/adg/issues/59)) ([0451923](https://github.com/RbBtSn0w/adg/commit/0451923bb5d498825e4a343b9c397a034185979b))
* harden maintenance and release contracts ([#66](https://github.com/RbBtSn0w/adg/issues/66)) ([0b87e63](https://github.com/RbBtSn0w/adg/commit/0b87e63f848e05cc143c69e3712be6da82425571))

## [0.7.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.6.0...0.7.0-beta.1) (2026-07-15)

### Added

* add support for resolved Git revisions in DSL and plugin rendering ([ddd6a8b](https://github.com/RbBtSn0w/adg/commit/ddd6a8b28fdfd1c8806e666737040701360267fb))
* mcp selective install ([#58](https://github.com/RbBtSn0w/adg/issues/58)) ([9cdd463](https://github.com/RbBtSn0w/adg/commit/9cdd46377b52bb47025c502b3b9fb8dc80236c3d))
* support structural skills repositories as plugins ([#64](https://github.com/RbBtSn0w/adg/issues/64)) ([b4160fc](https://github.com/RbBtSn0w/adg/commit/b4160fca77343525f8cead4db244202e06148b83))

### Fixed

* Bugfix ([#62](https://github.com/RbBtSn0w/adg/issues/62)) ([9db7d4a](https://github.com/RbBtSn0w/adg/commit/9db7d4ab03f719fe5c85f8f6b84e61d6c48f1e94))
* **deps:** resolve undici security advisories ([#65](https://github.com/RbBtSn0w/adg/issues/65)) ([cb3ca13](https://github.com/RbBtSn0w/adg/commit/cb3ca132923430f16f497fb9b1ec73e8bbb60876))
* harden Codex plugin cache recovery ([#63](https://github.com/RbBtSn0w/adg/issues/63)) ([77cdb3b](https://github.com/RbBtSn0w/adg/commit/77cdb3b0f9759c3ddcb074916718c4ba074f867f))
* harden plugin agent runtime integration ([#57](https://github.com/RbBtSn0w/adg/issues/57)) ([be23048](https://github.com/RbBtSn0w/adg/commit/be2304818ff88aef6273e3f44f7ff8685a6941fb))
* report skills update entrypoint failures ([#60](https://github.com/RbBtSn0w/adg/issues/60)) ([6af4eeb](https://github.com/RbBtSn0w/adg/commit/6af4eeb1ec44a6edc8a30a53c4f4e406485f0875))

### Changed

* Enhance OpenTelemetry compliance and improve error handling ([#59](https://github.com/RbBtSn0w/adg/issues/59)) ([0451923](https://github.com/RbBtSn0w/adg/commit/0451923bb5d498825e4a343b9c397a034185979b))
* harden maintenance and release contracts ([#66](https://github.com/RbBtSn0w/adg/issues/66)) ([0b87e63](https://github.com/RbBtSn0w/adg/commit/0b87e63f848e05cc143c69e3712be6da82425571))

## [0.6.0-beta.11](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.10...0.6.0-beta.11) (2026-07-14)

### Changed

* harden maintenance and release contracts ([#66](https://github.com/RbBtSn0w/adg/issues/66)) ([0b87e63](https://github.com/RbBtSn0w/adg/commit/0b87e63f848e05cc143c69e3712be6da82425571))

## [0.6.0-beta.10](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.9...0.6.0-beta.10) (2026-07-14)

### Fixed

* **deps:** resolve undici security advisories ([#65](https://github.com/RbBtSn0w/adg/issues/65)) ([cb3ca13](https://github.com/RbBtSn0w/adg/commit/cb3ca132923430f16f497fb9b1ec73e8bbb60876))

## [0.6.0-beta.9](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.8...0.6.0-beta.9) (2026-07-13)

### Added

* add support for resolved Git revisions in DSL and plugin rendering ([ddd6a8b](https://github.com/RbBtSn0w/adg/commit/ddd6a8b28fdfd1c8806e666737040701360267fb))

## [0.6.0-beta.8](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.7...0.6.0-beta.8) (2026-07-13)

### Added

* support structural skills repositories as plugins ([#64](https://github.com/RbBtSn0w/adg/issues/64)) ([b4160fc](https://github.com/RbBtSn0w/adg/commit/b4160fca77343525f8cead4db244202e06148b83))

## [0.6.0-beta.7](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.6...0.6.0-beta.7) (2026-07-12)

### Fixed

* harden Codex plugin cache recovery ([#63](https://github.com/RbBtSn0w/adg/issues/63)) ([77cdb3b](https://github.com/RbBtSn0w/adg/commit/77cdb3b0f9759c3ddcb074916718c4ba074f867f))

## [0.6.0-beta.6](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.5...0.6.0-beta.6) (2026-07-10)

### Fixed

* Bugfix ([#62](https://github.com/RbBtSn0w/adg/issues/62)) ([9db7d4a](https://github.com/RbBtSn0w/adg/commit/9db7d4ab03f719fe5c85f8f6b84e61d6c48f1e94))

## [0.6.0-beta.5](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.4...0.6.0-beta.5) (2026-07-09)

### Fixed

* report skills update entrypoint failures ([#60](https://github.com/RbBtSn0w/adg/issues/60)) ([6af4eeb](https://github.com/RbBtSn0w/adg/commit/6af4eeb1ec44a6edc8a30a53c4f4e406485f0875))

## [0.6.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.3...0.6.0-beta.4) (2026-07-08)

### Changed

* Enhance OpenTelemetry compliance and improve error handling ([#59](https://github.com/RbBtSn0w/adg/issues/59)) ([0451923](https://github.com/RbBtSn0w/adg/commit/0451923bb5d498825e4a343b9c397a034185979b))

## [0.6.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.2...0.6.0-beta.3) (2026-07-07)

### Added

* mcp selective install ([#58](https://github.com/RbBtSn0w/adg/issues/58)) ([9cdd463](https://github.com/RbBtSn0w/adg/commit/9cdd46377b52bb47025c502b3b9fb8dc80236c3d))

## [0.6.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.6.0-beta.1...0.6.0-beta.2) (2026-07-06)

### Fixed

* harden plugin agent runtime integration ([#57](https://github.com/RbBtSn0w/adg/issues/57)) ([be23048](https://github.com/RbBtSn0w/adg/commit/be2304818ff88aef6273e3f44f7ff8685a6941fb))

## [0.6.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.5.0...0.6.0-beta.1) (2026-07-05)

## [0.6.0](https://github.com/RbBtSn0w/adg/compare/0.5.0...0.6.0) (2026-07-05)


### Added

* add adg self-update wrapper ([#48](https://github.com/RbBtSn0w/adg/issues/48)) ([62751ab](https://github.com/RbBtSn0w/adg/commit/62751ab82e4855e134d892a4f9143af98f1c24cb))
* implement OpenTelemetry tracing and subprocess instrumentation ([#43](https://github.com/RbBtSn0w/adg/issues/43)) ([0404c5c](https://github.com/RbBtSn0w/adg/commit/0404c5cb51d31b8f3d4541b547c8fe855eb3494d))

### Fixed

* address release review findings ([e8d7fce](https://github.com/RbBtSn0w/adg/commit/e8d7fce4369b522368c6ce14d263ab12736db5dc))
* antigravity mcp hook matchers ([#44](https://github.com/RbBtSn0w/adg/issues/44)) ([88e0aaf](https://github.com/RbBtSn0w/adg/commit/88e0aafbd08ba95d44ba2a986755dff481f3c45b))
* make Claude marketplace sync fail open ([#50](https://github.com/RbBtSn0w/adg/issues/50)) ([6047d74](https://github.com/RbBtSn0w/adg/commit/6047d74f38edaf40395328cfe3920b41e8f10a54))
* **telemetry): restore audit/version + chore(vendor:** re-sync skills CLI to v1.5.14 ([#45](https://github.com/RbBtSn0w/adg/issues/45)) ([59082bd](https://github.com/RbBtSn0w/adg/commit/59082bd527eb8f4bc2b9bea4ac4102a591f1ad2d))
* typo ([c9ac759](https://github.com/RbBtSn0w/adg/commit/c9ac75974e094ae4a3c06f38cc93741f8e55a5c7))

### Changed

* Add copy-paste prompt for setting up ADG with coding agents ([3981d9b](https://github.com/RbBtSn0w/adg/commit/3981d9bd9ce978e669e0c84369263c69800c9fc0))

## [0.5.0](https://github.com/RbBtSn0w/adg/compare/0.4.0...0.5.0) (2026-07-05)

### Added

* Implement OpenTelemetry tracing and enhance plugin management ([#51](https://github.com/RbBtSn0w/adg/issues/51)) ([eca87b4](https://github.com/RbBtSn0w/adg/commit/eca87b449b42139e8e4365970ffbc052c7c1fe02)), closes [#43](https://github.com/RbBtSn0w/adg/issues/43) [#44](https://github.com/RbBtSn0w/adg/issues/44) [#46](https://github.com/RbBtSn0w/adg/issues/46)

## [0.5.0-beta.7](https://github.com/RbBtSn0w/adg/compare/0.5.0-beta.6...0.5.0-beta.7) (2026-07-05)

### Fixed

* address release review findings ([e8d7fce](https://github.com/RbBtSn0w/adg/commit/e8d7fce4369b522368c6ce14d263ab12736db5dc))

## [0.5.0-beta.6](https://github.com/RbBtSn0w/adg/compare/0.5.0-beta.5...0.5.0-beta.6) (2026-07-05)

### Fixed

* typo ([c9ac759](https://github.com/RbBtSn0w/adg/commit/c9ac75974e094ae4a3c06f38cc93741f8e55a5c7))

## [0.5.0-beta.5](https://github.com/RbBtSn0w/adg/compare/0.5.0-beta.4...0.5.0-beta.5) (2026-07-03)

### Fixed

* make Claude marketplace sync fail open ([#50](https://github.com/RbBtSn0w/adg/issues/50)) ([6047d74](https://github.com/RbBtSn0w/adg/commit/6047d74f38edaf40395328cfe3920b41e8f10a54))

## [0.5.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.5.0-beta.3...0.5.0-beta.4) (2026-07-03)

### Added

* add adg self-update wrapper ([#48](https://github.com/RbBtSn0w/adg/issues/48)) ([62751ab](https://github.com/RbBtSn0w/adg/commit/62751ab82e4855e134d892a4f9143af98f1c24cb))

## [0.5.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.5.0-beta.2...0.5.0-beta.3) (2026-07-02)

### Fixed

* **telemetry): restore audit/version + chore(vendor:** re-sync skills CLI to v1.5.14 ([#45](https://github.com/RbBtSn0w/adg/issues/45)) ([59082bd](https://github.com/RbBtSn0w/adg/commit/59082bd527eb8f4bc2b9bea4ac4102a591f1ad2d))

## [0.5.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.5.0-beta.1...0.5.0-beta.2) (2026-07-02)

### Fixed

* antigravity mcp hook matchers ([#44](https://github.com/RbBtSn0w/adg/issues/44)) ([88e0aaf](https://github.com/RbBtSn0w/adg/commit/88e0aafbd08ba95d44ba2a986755dff481f3c45b))

## [0.5.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.4.0...0.5.0-beta.1) (2026-07-01)

### Added

* implement OpenTelemetry tracing and subprocess instrumentation ([#43](https://github.com/RbBtSn0w/adg/issues/43)) ([0404c5c](https://github.com/RbBtSn0w/adg/commit/0404c5cb51d31b8f3d4541b547c8fe855eb3494d))

## [0.4.0](https://github.com/RbBtSn0w/adg/compare/0.3.0...0.4.0) (2026-06-29)

### Added

* add --json flag to plugins list and status commands ([#38](https://github.com/RbBtSn0w/adg/issues/38)) ([6707415](https://github.com/RbBtSn0w/adg/commit/6707415e81ea44a57c0368e9b296342c663e2176))
* adopt canonical mcpServers manifest field and deprecate mcp ([#35](https://github.com/RbBtSn0w/adg/issues/35)) ([9a4d6a4](https://github.com/RbBtSn0w/adg/commit/9a4d6a4891e5af684fc5f3b473add6075f7f3882))
* **antigravity:** project plugins directly on disk without agy CLI ([#39](https://github.com/RbBtSn0w/adg/issues/39)) ([8886554](https://github.com/RbBtSn0w/adg/commit/8886554be8834447d08a2694eeec4eaab90e8f80))
* **codex:** preserve agent query failures and recovery commands ([#40](https://github.com/RbBtSn0w/adg/issues/40)) ([5565068](https://github.com/RbBtSn0w/adg/commit/5565068eed94f3cdb869598342ff321853919d5d))
* **hooks:** cross-agent hooks compatibility + universal hooks DSL ([#33](https://github.com/RbBtSn0w/adg/issues/33)) ([8c0d1d1](https://github.com/RbBtSn0w/adg/commit/8c0d1d1c1e5fa50154f55a390195106281a0aa3b))
* **plugins:** add unlink/sync/status verbs and fix antigravity residual ([#27](https://github.com/RbBtSn0w/adg/issues/27)) ([c47e598](https://github.com/RbBtSn0w/adg/commit/c47e5984fef2c78cf4eeef5eab2612aa5bf899b2))
* **plugins:** guide scope for mutating verbs and guard the home==global trap ([#31](https://github.com/RbBtSn0w/adg/issues/31)) ([433d95b](https://github.com/RbBtSn0w/adg/commit/433d95b7fbfc98d05606cc9e4ec11d2ba6df8868))

### Fixed

* **release:** add release rules for refactor type to trigger patch releases ([973ccda](https://github.com/RbBtSn0w/adg/commit/973ccda44369d456c65249b22a1f1ac23c1f18fc))

### Changed

* decompose bin/adg.ts, memoize CLI probe, dedup agent skips, alias marketplace upgrade ([#26](https://github.com/RbBtSn0w/adg/issues/26)) ([#29](https://github.com/RbBtSn0w/adg/issues/29)) ([a93f643](https://github.com/RbBtSn0w/adg/commit/a93f6431793e1c546f396660eeb776adb007889a))
* **hooks:** retire adg.hooks/v1 DSL; converge on Claude's hook format ([#34](https://github.com/RbBtSn0w/adg/issues/34)) ([1997041](https://github.com/RbBtSn0w/adg/commit/19970418d6ffe6616f05f0cd214ba98bd2e4f331)), closes [#32](https://github.com/RbBtSn0w/adg/issues/32)
* remove asc and github-cr plugin files and update .gitignore ([e3b0a7a](https://github.com/RbBtSn0w/adg/commit/e3b0a7a78a75ce5ced17439a73c4b70c09705a3c))

## [0.4.0-beta.9](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.8...0.4.0-beta.9) (2026-06-29)

### Added

* **codex:** preserve agent query failures and recovery commands ([#40](https://github.com/RbBtSn0w/adg/issues/40)) ([5565068](https://github.com/RbBtSn0w/adg/commit/5565068eed94f3cdb869598342ff321853919d5d))

## [0.4.0-beta.8](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.7...0.4.0-beta.8) (2026-06-27)

### Added

* **antigravity:** project plugins directly on disk without agy CLI ([#39](https://github.com/RbBtSn0w/adg/issues/39)) ([8886554](https://github.com/RbBtSn0w/adg/commit/8886554be8834447d08a2694eeec4eaab90e8f80))

## [0.4.0-beta.7](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.6...0.4.0-beta.7) (2026-06-26)

### Added

* add --json flag to plugins list and status commands ([#38](https://github.com/RbBtSn0w/adg/issues/38)) ([6707415](https://github.com/RbBtSn0w/adg/commit/6707415e81ea44a57c0368e9b296342c663e2176))

## [0.4.0-beta.6](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.5...0.4.0-beta.6) (2026-06-26)

### Added

* adopt canonical mcpServers manifest field and deprecate mcp ([#35](https://github.com/RbBtSn0w/adg/issues/35)) ([9a4d6a4](https://github.com/RbBtSn0w/adg/commit/9a4d6a4891e5af684fc5f3b473add6075f7f3882))

## [0.4.0-beta.5](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.4...0.4.0-beta.5) (2026-06-26)

### Changed

* **hooks:** retire adg.hooks/v1 DSL; converge on Claude's hook format ([#34](https://github.com/RbBtSn0w/adg/issues/34)) ([1997041](https://github.com/RbBtSn0w/adg/commit/19970418d6ffe6616f05f0cd214ba98bd2e4f331)), closes [#32](https://github.com/RbBtSn0w/adg/issues/32)

## [0.4.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.3...0.4.0-beta.4) (2026-06-25)

### Added

* **hooks:** cross-agent hooks compatibility + universal hooks DSL ([#33](https://github.com/RbBtSn0w/adg/issues/33)) ([8c0d1d1](https://github.com/RbBtSn0w/adg/commit/8c0d1d1c1e5fa50154f55a390195106281a0aa3b))

## [0.4.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.2...0.4.0-beta.3) (2026-06-25)

### Added

* **plugins:** guide scope for mutating verbs and guard the home==global trap ([#31](https://github.com/RbBtSn0w/adg/issues/31)) ([433d95b](https://github.com/RbBtSn0w/adg/commit/433d95b7fbfc98d05606cc9e4ec11d2ba6df8868))

## [0.4.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.1...0.4.0-beta.2) (2026-06-25)

### Fixed

* **release:** add release rules for refactor type to trigger patch releases ([973ccda](https://github.com/RbBtSn0w/adg/commit/973ccda44369d456c65249b22a1f1ac23c1f18fc))

### Changed

* decompose bin/adg.ts, memoize CLI probe, dedup agent skips, alias marketplace upgrade ([#26](https://github.com/RbBtSn0w/adg/issues/26)) ([#29](https://github.com/RbBtSn0w/adg/issues/29)) ([a93f643](https://github.com/RbBtSn0w/adg/commit/a93f6431793e1c546f396660eeb776adb007889a))
* remove asc and github-cr plugin files and update .gitignore ([e3b0a7a](https://github.com/RbBtSn0w/adg/commit/e3b0a7a78a75ce5ced17439a73c4b70c09705a3c))

## [0.4.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.3.0...0.4.0-beta.1) (2026-06-23)

### Added

* **plugins:** add unlink/sync/status verbs and fix antigravity residual ([#27](https://github.com/RbBtSn0w/adg/issues/27)) ([c47e598](https://github.com/RbBtSn0w/adg/commit/c47e5984fef2c78cf4eeef5eab2612aa5bf899b2))

## [0.3.0](https://github.com/RbBtSn0w/adg/compare/0.2.1...0.3.0) (2026-06-22)

### Added

* add support for Antigravity adapter and enhance agent detection ([#10](https://github.com/RbBtSn0w/adg/issues/10)) ([91d0a63](https://github.com/RbBtSn0w/adg/commit/91d0a6374f5dc25281667e306062bebf0fb08903))
* enhance plugin agent listing and error messaging ([#8](https://github.com/RbBtSn0w/adg/issues/8)) ([bc392d1](https://github.com/RbBtSn0w/adg/commit/bc392d14f16993bc4ee8b4e3bf85ee2936063ddf))
* **plugins:** align `plugins update` with `skills update` (detect-then-update) ([#21](https://github.com/RbBtSn0w/adg/issues/21)) ([2b93c01](https://github.com/RbBtSn0w/adg/commit/2b93c01b03a65fab93a0befe3ea05b5d4639478f))
* refresh cached agents on plugin update ([#22](https://github.com/RbBtSn0w/adg/issues/22)) ([6566a74](https://github.com/RbBtSn0w/adg/commit/6566a7476d30495a94aa69a7e0de1bb60edae883))

### Fixed

* address cross-cutting correctness findings from PR review ([824db40](https://github.com/RbBtSn0w/adg/commit/824db4050860ec85c09325755bae2932b5384a26))
* address technical debt items TD-1, TD-2, TD-3 ([#13](https://github.com/RbBtSn0w/adg/issues/13)) ([955a69a](https://github.com/RbBtSn0w/adg/commit/955a69ad5cfa2f628ea3667548a8f542d29d54cf))
* project apps, add adapter parity test, harden prepack & audit gates ([#15](https://github.com/RbBtSn0w/adg/issues/15) [#17](https://github.com/RbBtSn0w/adg/issues/17) [#18](https://github.com/RbBtSn0w/adg/issues/18) [#19](https://github.com/RbBtSn0w/adg/issues/19)) ([#20](https://github.com/RbBtSn0w/adg/issues/20)) ([a63ad26](https://github.com/RbBtSn0w/adg/commit/a63ad264d3eec106e92e3d7bc4b805c09c3f74f8)), closes [#3](https://github.com/RbBtSn0w/adg/issues/3)
* **update-check:** notify on beta/rc updates via prerelease-aware compare ([#12](https://github.com/RbBtSn0w/adg/issues/12)) ([264163a](https://github.com/RbBtSn0w/adg/commit/264163aa47e60675c1a2a0e3817755328efae362))

### Changed

* **adapters:** fix naming, dedup strict logic (tech-debt [#9](https://github.com/RbBtSn0w/adg/issues/9)) ([#11](https://github.com/RbBtSn0w/adg/issues/11)) ([33d9727](https://github.com/RbBtSn0w/adg/commit/33d97274c6ba64bb709dee5c7478862edc87a10b))
* centralize CLI execution and availability logic into a reusable makeCli factory ([#16](https://github.com/RbBtSn0w/adg/issues/16)) ([00f1454](https://github.com/RbBtSn0w/adg/commit/00f1454dd6822dc005a11835bf052a5468975e64))
* **ci:** avoid literal skip-CI directive in prose ([dbfac2d](https://github.com/RbBtSn0w/adg/commit/dbfac2d7e87ffcec6153a4be07e9e43e6affb331)), closes [#6](https://github.com/RbBtSn0w/adg/issues/6)

## [0.3.0-beta.8](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.7...0.3.0-beta.8) (2026-06-22)

### Fixed

* address cross-cutting correctness findings from PR review ([824db40](https://github.com/RbBtSn0w/adg/commit/824db4050860ec85c09325755bae2932b5384a26))

## [0.3.0-beta.7](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.6...0.3.0-beta.7) (2026-06-22)

### Added

* refresh cached agents on plugin update ([#22](https://github.com/RbBtSn0w/adg/issues/22)) ([6566a74](https://github.com/RbBtSn0w/adg/commit/6566a7476d30495a94aa69a7e0de1bb60edae883))

## [0.3.0-beta.6](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.5...0.3.0-beta.6) (2026-06-22)

### Added

* **plugins:** align `plugins update` with `skills update` (detect-then-update) ([#21](https://github.com/RbBtSn0w/adg/issues/21)) ([2b93c01](https://github.com/RbBtSn0w/adg/commit/2b93c01b03a65fab93a0befe3ea05b5d4639478f))

## [0.3.0-beta.5](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.4...0.3.0-beta.5) (2026-06-22)

### Fixed

* project apps, add adapter parity test, harden prepack & audit gates ([#15](https://github.com/RbBtSn0w/adg/issues/15) [#17](https://github.com/RbBtSn0w/adg/issues/17) [#18](https://github.com/RbBtSn0w/adg/issues/18) [#19](https://github.com/RbBtSn0w/adg/issues/19)) ([#20](https://github.com/RbBtSn0w/adg/issues/20)) ([a63ad26](https://github.com/RbBtSn0w/adg/commit/a63ad264d3eec106e92e3d7bc4b805c09c3f74f8)), closes [#3](https://github.com/RbBtSn0w/adg/issues/3)

### Changed

* centralize CLI execution and availability logic into a reusable makeCli factory ([#16](https://github.com/RbBtSn0w/adg/issues/16)) ([00f1454](https://github.com/RbBtSn0w/adg/commit/00f1454dd6822dc005a11835bf052a5468975e64))

## [0.3.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.3...0.3.0-beta.4) (2026-06-20)

### Fixed

* address technical debt items TD-1, TD-2, TD-3 ([#13](https://github.com/RbBtSn0w/adg/issues/13)) ([955a69a](https://github.com/RbBtSn0w/adg/commit/955a69ad5cfa2f628ea3667548a8f542d29d54cf))

## [0.3.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.2...0.3.0-beta.3) (2026-06-20)

### Fixed

* **update-check:** notify on beta/rc updates via prerelease-aware compare ([#12](https://github.com/RbBtSn0w/adg/issues/12)) ([264163a](https://github.com/RbBtSn0w/adg/commit/264163aa47e60675c1a2a0e3817755328efae362))

### Changed

* **adapters:** fix naming, dedup strict logic (tech-debt [#9](https://github.com/RbBtSn0w/adg/issues/9)) ([#11](https://github.com/RbBtSn0w/adg/issues/11)) ([33d9727](https://github.com/RbBtSn0w/adg/commit/33d97274c6ba64bb709dee5c7478862edc87a10b))

## [0.3.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.1...0.3.0-beta.2) (2026-06-20)

### Added

* add support for Antigravity adapter and enhance agent detection ([#10](https://github.com/RbBtSn0w/adg/issues/10)) ([91d0a63](https://github.com/RbBtSn0w/adg/commit/91d0a6374f5dc25281667e306062bebf0fb08903))

## [0.3.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.2.1...0.3.0-beta.1) (2026-06-19)

### Added

* enhance plugin agent listing and error messaging ([#8](https://github.com/RbBtSn0w/adg/issues/8)) ([bc392d1](https://github.com/RbBtSn0w/adg/commit/bc392d14f16993bc4ee8b4e3bf85ee2936063ddf))

### Changed

* **ci:** avoid literal skip-CI directive in prose ([dbfac2d](https://github.com/RbBtSn0w/adg/commit/dbfac2d7e87ffcec6153a4be07e9e43e6affb331)), closes [#6](https://github.com/RbBtSn0w/adg/issues/6)

## [0.2.1](https://github.com/RbBtSn0w/adg/compare/0.2.0...0.2.1) (2026-06-19)


### Bug Fixes

* **brew:** Add Homebrew tap publishing for stable releases ([#5](https://github.com/RbBtSn0w/adg/issues/5)) ([0546dc9](https://github.com/RbBtSn0w/adg/commit/0546dc9172b8d93f1d7c34587df28383c21b52da))

# [0.2.0](https://github.com/RbBtSn0w/adg/compare/0.1.1...0.2.0) (2026-06-19)


### Features

* **version:** Add root version flag and cached update notice to the ADG CLI ([#4](https://github.com/RbBtSn0w/adg/issues/4)) ([bbce576](https://github.com/RbBtSn0w/adg/commit/bbce576b21de9822adff07c67d90b853b0cf4265))

## [0.1.1](https://github.com/RbBtSn0w/adg/compare/0.1.0...0.1.1) (2026-06-18)


### Bug Fixes

* **adapters:** codex projection passes skills root through in strict mode ([#3](https://github.com/RbBtSn0w/adg/issues/3)) ([f8de95d](https://github.com/RbBtSn0w/adg/commit/f8de95dff26d3e7032538b64919d7031ce6e8cef))

# [0.1.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.1.0-beta.2...0.1.0-beta.3) (2026-06-18)


### Bug Fixes

* address PR [#2](https://github.com/RbBtSn0w/adg/issues/2) review feedback ([f614817](https://github.com/RbBtSn0w/adg/commit/f6148173e32a331f6c7dd859b50dd85cd453253d))

# [0.1.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.1.0-beta.1...0.1.0-beta.2) (2026-06-18)


### Bug Fixes

* cut 0.1.0-beta.2 ([7ed703a](https://github.com/RbBtSn0w/adg/commit/7ed703a88b6d52c14605d62b4e7952c00839e6b2))

# Changelog

All notable changes to the `adg` toolkit are recorded here.

## Unreleased

## 0.1.0 — 2026-06-17

### Added — `adg plugins init --type plugin|marketplace|all`
The authoring scenario is now the `.agents/` artifact *kind*, not a runtime.
`--type plugin` (default) scaffolds `.agents/.plugin.json`; `marketplace`
scaffolds a `.agents/.marketplace.json` catalog; `all` scaffolds a catalog root
plus one starter member plugin in a subdirectory. (This is a different axis from
`adapt --target claude|codex|all`, which selects a runtime to project for.)

### Changed — vendor projections are no longer an authoring artifact
`.claude-plugin/` and `.codex-plugin/` are runtime projections produced at
**install** time (by `adg plugins add`, into the consumer tree) — authors commit
only `.agents/`. You run `adg plugins adapt` and commit projections solely to
publish to a runtime's native registry. Docs (`authoring.md`, `agents-spec.md`)
updated accordingly; `validate` projection-sync only applies when projections are
present.

### Removed — the `adapters` manifest field
Output paths for the runtime projections (`.claude-plugin/`, `.codex-plugin/`)
are ADG-internal conventions mandated by each runtime, not producer-configurable.
The `adapters` field is removed from the DSL (schema, types, `init`/`reverse`/
`import` scaffolding) and from `adapt` (always the default path). A stray
`adapters` from an old manifest is tolerated (ignored), so existing plugins keep
installing.

### Changed — consumer manifest-resolution priority
When a directory exposes more than one manifest, resolution order is now
`.agents/.plugin.json` (then legacy `.adg-plugin`) → Claude (`.claude-plugin`) →
Codex (`.codex-plugin`). Previously Codex was checked before Claude.

### Changed — simpler authored `marketplace.json` DSL
A `plugins[].source` may now be a plain string (local path shorthand, e.g.
`"./asc"`) in addition to the object form, and gains remote tagged-union forms
(`github` / `git`) in the schema. Catalogs gain top-level `description` / `owner`
(replacing `interface.displayName`); `policy` is documented as export-only. The
generated runtime export is unchanged (Codex still gets the object + policy
shape).

### Changed — plugin source manifest moves to `.agents/.plugin.json`
The canonical source manifest is now `.agents/.plugin.json` (was
`.adg-plugin/plugin.json`) — a neutral, vendor-agnostic home that mirrors the
`.claude-plugin/` shape. The repo source catalog convention is
`.agents/.marketplace.json`. Runtime projections (`.claude-plugin/`,
`.codex-plugin/`) and the Codex/Claude-facing `marketplace.json` export are
unchanged. The legacy `.adg-plugin/plugin.json` is still read (deprecated) so
existing plugins keep resolving. See [docs/agents-spec.md](docs/agents-spec.md).

### Changed — packaging is now a manifest-driven allowlist
Installing/cloning a plugin ships only its declared payload (component
directories named in the manifest + `README`/`LICENSE`/`CHANGELOG`/`NOTICE` +
generated projections) instead of copying everything minus
`.git`/`node_modules`. Dev cruft like `src/`, `test/`, `docs/` no longer leaks
into installs. The same allowlist drives both the copy and the content hash, so
in-place and copied installs hash identically (`src/package.ts`).

### Fixed — `adg skills` against private repos (and, in fact, all updates)
A private skill source (`adg skills update`) reported `✗ Failed to fetch tree`
then falsely claimed "up to date". Investigating uncovered three stacked bugs in
the vendored skills fork, all now patched (see `vendor/skills/PROVENANCE.md`):

1. **Private repos never authenticated.** `fetchRepoTree` only retried with a
   token after a rate-limit 403; a private repo returns 404 to anonymous callers,
   so the token was never used. Now retries authenticated on 401/403/404.
2. **Updates could never run.** The updater re-invoked a built `bin/cli.mjs` that
   a source-only vendoring doesn't ship ("CLI entrypoint not found"). Now invokes
   the TS source entry via Node type-stripping.
3. **Every clone failed.** simple-git ≥3.36 blocks `filter.*.smudge/clean`
   configs unless opted in. Added `unsafe: { allowUnsafeFilter: true }` (the
   filters are set empty — disabling LFS — so this is safe).

Also: failed update sources are now surfaced (with a `GITHUB_TOKEN` / `gh auth
login` hint) instead of being hidden behind a false "all up to date", and the
`gh`-token warning text no longer hardcodes "rate limit reached".

### Fixed — collection repos no longer "fully update" every run
A repo containing many skills re-flagged **all** of them as needing an update on
every `adg skills update`, regardless of what changed. Root cause: install and
update used two different hash schemes. A github source records the git **tree
SHA** when the Trees API succeeds, but the git-clone fallback recorded a sha256
**content hash** — and update-check always compares against the tree SHA, so any
clone-fallback install (e.g. a private repo before the auth fix above) mismatched
forever. Now the clone fallback derives the git tree SHA too (one scheme), and a
self-heal normalizes pre-existing legacy hashes on the next update — no lock wipe.

## 0.1.0-alpha.1 — 2026-06-12

First alpha. The architecture and scope are frozen in [docs/agents-spec.md](docs/agents-spec.md).

### Added
- **Two-domain CLI**: `adg plugins <verb>` and `adg skills <verb>` under one
  umbrella binary, each mapped to one subtree of the universal `.agents/` home.
- **Plugins domain** (zero runtime deps): `init`, `adapt`, `validate`, `add`,
  `import`, `import-skills`, `link`, `update`, `list`. One canonical
  `.adg-plugin/plugin.json` source projects to `.codex-plugin` / `.claude-plugin`
  via an adapter registry; provenance + `sha256` integrity live in
  `.plugin-lock.json`, with `marketplace.json` as a thin runtime export.
- **Skills domain**: vendored fork of `vercel-labs/skills` delegated to via the
  `adg skills` namespace (see `vendor/skills/PROVENANCE.md`).
- **Architecture spec** at `docs/agents-spec.md` (goals, directory layout, artifact
  ownership, core data structures, multi-agent anti-scatter guarantees).
- Guard tests pinning the `.agents/` core invariant against future re-vendoring.

### Changed
- Maintain a single `.agents/` home across both domains. Patched the vendored
  skills fork so the **global skill lock** and the **universal global skills
  dir** resolve under `$XDG_STATE_HOME/.agents` (or `~/.agents`) instead of
  upstream's split `$XDG_CONFIG_HOME/agents/...` and `$XDG_STATE_HOME/skills/...`
  paths. Both patches are recorded in `vendor/skills/PROVENANCE.md`.
