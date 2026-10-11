# Cua 0.34.1 upgrade, native revision 40

Synara now pins Cua 0.34.1 and native revision 40. Both local patches have
been rebased. The patched driver builds for macOS arm64 and Intel; the required
native fixtures pass on arm64. Background Chromium synthetic input still has
delivery limits described below. This record covers the source change and owned
fixtures. Release signing and real provider tasks remain unverified.

The work began on 10 October and qualification finished on 11 October 2026.
The [release manifest](../../packages/shared/src/cuaDriverRelease.json) pins
the source, Rust version and checksums. The sanitized
[qualification evidence](evidence/upgrade-0.34.1-2026-10-10/qualification.json)
records the exact builds and fixture results without retaining observations of
the user's applications.

The [check results](evidence/upgrade-0.34.1-2026-10-10/checks.json) include the
repository test counts and the temporary test setup.

## What changed

| Item                   | Previous pin                               | Current pin                                |
| ---------------------- | ------------------------------------------ | ------------------------------------------ |
| Upstream version       | 0.28.2                                     | 0.34.1                                     |
| Source commit          | `7fe7c33f741ee2dd5961ba80044d59f93b48ba47` | `0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc` |
| Synara native revision | 39                                         | 40                                         |
| Rust toolchain         | 1.97.1                                     | 1.97.1                                     |

The current base is the published
[cua-driver-rs-v0.34.1 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.1).
Synara continues to build that source with its own patches. The native host
checks the driver version, revision, embedded mode and exact child PID before
accepting it. A stock upstream macOS binary does not satisfy that handshake.

The patches are now single cumulative diffs: first the native patch, then the
Linux browser delta. Applying both to a fresh archive of the pinned commit
reproduced all 1,306 tracked driver files byte for byte. The provisioner also
archives upstream's telemetry crate and the two JSON resources now read during
compilation. Those dependencies come from the same pinned commit.

### Upstream changes kept

Upstream now uses opaque `element_token` references and rejects unknown action
arguments. Synara's web-field adapter no longer sends `element_index`. A new AX
snapshot, from the macOS accessibility API, replaces that window's tokens. An
action retains its resolved AX
element while it runs. Screenshot-only reads do not publish another tree. The
fixture refreshes its reference after a text write that triggers a new tree.

The rebase keeps upstream's Finder rename refusal, menu matching and dismissal,
launch readiness, bare-key modifier flags, foreground HID drag fields, cursor
trajectories, bounded accessibility walking and strict browser-helper signing.
Old local implementations of those paths were reconciled with the new source
instead of layering a second action or fallback on top.

### Synara behavior kept and fixed

Exact PID, window, element, modal and Space checks still precede native input.
Ambiguous process-scoped keys refuse before dispatch. Exact semantic text can
write into one observed accessibility field without activating its window.
Background clicks do not
activate their target or use an off-screen click primer. An uncertain dispatch
does not authorize another click.

Release events are prepared before key or mouse downs. Stop, cancellation and
target invalidation unwind those guards. Foreground drag retains upstream's HID
route under Synara's target guard. Live fixtures exposed two additional issues:
a modifier pressed as the base key lacked its own down flag, and foreground
clicks needed the admitted window's routing fields. Revision 40 fixes both.
The click path prepares the matching release before posting its down, and each
down or up is posted once through the selected route.

AX prefetch shares the walk's node and time budgets. The clock starts before the
first batch, workers and batches remain bounded, and expired workers stop
requesting optional data. Skipped or failed post-action observation reports
`polled:false`; it does not claim that a poll found no change.

An isolated browser receives a cleanup owner immediately after launch, before
endpoint discovery first awaits. Dropping or cancelling setup reaps only that
owned process group and marked profile. The shared fix applies to macOS and
Linux. The Linux patch preserves browser-only input admission and cleanup
acknowledgements. It does not enable Linux native desktop input.

## Live arm64 qualification

Electron 43.4.1 and an owned AppKit target ran from temporary, ad-hoc signed
bundles. Input addressed only independently identified fixture windows. The
runner used existing grants and did not request permissions. Foreground and
full-screen transitions were confined to the owned cancellation fixture.

| Case                                                          | Result                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Exact semantic text into three Electron windows               | Passed; each field matched, no fixture focus takeover                                    |
| AppKit single-window typing and AX value replacement          | Passed                                                                                   |
| Same-PID sibling keyboard ambiguity                           | Refused before input                                                                     |
| Parent click behind an attached sheet                         | Refused before input                                                                     |
| Exact control inside the attached sheet                       | Passed; one modal counter increment                                                      |
| Background AppKit click alongside independent foreground keys | Passed; one click, 10 key downs, 10 key ups, 10 characters                               |
| Stop during first down of a double-click                      | Passed; one down, one up, no second click; 127 ms                                        |
| Stop during typing                                            | Passed; balanced key release, no later text; 176 ms                                      |
| Stop during held foreground drag                              | Passed; one release and no later drag events; 168 ms                                     |
| Stop during Shift-click                                       | Passed; mouse and modifier released; 173 ms                                              |
| Real Space change during foreground typing                    | Passed; target guard stopped input and OS readback showed key and mouse released         |
| Embedded cancellation control probe                           | 12 cases passed on both arm64 and the universal binary's arm64 slice; clean process exit |

The independent foreground key stream used AppKit events inside the owned app.
It proves coexistence with that app's event stream, not physical-human input.
The 50 Hz sampler observed no focus excursion during that case, with complete
PID, key-window and focused-element coverage. Top-window coverage was 20%.

During the full-screen Space transition, the original renderer did not observe
the final key-up. The fixture therefore checked the known key and left mouse
button through CoreGraphics as well as checking that text stopped changing.
Both OS states were released. Application delivery of that key-up is unproven.

### Delivery and observation limits

Bare background Chromium typing reported dispatch but did not change the
fixture field. The same case failed with the old 0.28.2 revision 39 binary using
the same fixture and Electron version. Exact semantic text passed on both.
The separate background regression runner also failed to prove forced Chromium
pixel clicks and consistent Enter delivery on either version. These results
remain uncertain dispatches. No target activation or automatic replay was used
to turn them into a passing result.

Five gateway action and admission cases passed. The gateway focus sampler
recorded a transition from the owned fixture to an outside application after
the click. Its cause is unproven, so that run does not qualify gateway focus
neutrality. The controlled AppKit coexistence case above has its own passing
focus evidence.

Intel compilation and universal Mach-O assembly passed. Intel runtime, Linux
native compilation/runtime, Windows runtime, physical Escape/takeover,
distribution signing/notarization and full packaged provider tasks remain
unverified by this upgrade. Released Computer Use remains macOS-only and beta;
the update does not expand that support claim.

## Verification

| Check                                        | Result                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `bun run fmt:check`                          | Passed                                                            |
| `bun run lint`                               | Passed, zero errors and 887 warnings                              |
| `bun run typecheck`                          | All seven package checks passed                                   |
| `bun run windows-runtime:check`              | Passed                                                            |
| Repository Vitest coverage                   | 16,383 passed, 38 skipped across the runs described below         |
| Rust contracts / core / cursor / macOS / CLI | 61 / 881 / 152 / 580 / 305 passed; seven macOS GUI tests ignored  |
| Linux delta's portable core policy           | 888 passed on macOS, including browser-only admission and cleanup |
| Fresh source reconstruction                  | Both patches applied; 1,306 files matched, no unexpected files    |
| Local provisioner builds                     | arm64 and universal passed; `lipo` confirmed arm64 and x86_64     |
| Cancellation probes                          | 12 cases passed for each staged binary; both exited cleanly       |
| Documentation links and manifest hashes      | Passed                                                            |

Rust tests used the pinned 1.97.1 toolchain. Repository tests used the pinned
Node 24.13.1 and Bun 1.4.2. Node 26 cannot run the shared test's TypeScript
transform mode. Git tests used a temporary global config with signing and
fsmonitor disabled; local test hook configuration could still override it.
The user's Git configuration was not changed.

The monolithic root run completed contracts, scripts, shared, web and desktop
tests. Its server phase reported two checkpoint failures and stalled in an
unchanged Git worktree-copy test. The checkpoint cases passed in isolation.
The whole Git integration file passed separately, with 131 tests. The remaining
server run covered 579 files and reported 28 failures across three files, plus
three unhandled errors, after default provider-home reads encountered an auth
symlink or timed out.

Those three files, `codexAppServerManager`, `CodexTextGeneration` and
`ProviderHealth`, then passed all 352 active tests with a temporary test setup.
It mocked only the inherited default Codex home resolver to return an empty
fixture directory. Explicit test homes and authentication checks remained in
place. The test process also used a temporary Synara home. No authentication
file or provider implementation changed. The combined count above includes
each test once and records this difference from a clean monolithic pass.

The binaries were built by the actual provisioner from the pinned source and
patches, then ad-hoc signed. Their hashes and universal architectures are in
the evidence. These are local build artifacts, not published release archives.

## Reproduce the scoped checks

Use an isolated source checkout, Cargo cache and target directory with Rust
1.97.1 available. The provisioner requires the checkout at the pinned commit.

```sh
node apps/desktop/scripts/provision-cua-driver.mjs \
  --source-checkout /private/tmp/cua-source \
  --destination /private/tmp/cua-stage --arch universal

node scripts/computer-use-fixtures/probe-native-cancellation.mjs \
  /private/tmp/cua-stage/cua-driver
```

Build the owned GUI fixture in a temporary bundle, with the driver override
pointing to that staged build. The two foreground opt-ins below authorize only
the owned fixture actions described here; omit them for a passive run.

```sh
SYNARA_CUA_FIXTURE_APP='/private/tmp/Synara Cua Fixture.app' \
SYNARA_CUA_FIXTURE_DRIVER=/private/tmp/cua-stage/cua-driver \
node scripts/computer-use-fixtures/build-electron.mjs

SYNARA_CUA_FIXTURE_DIR=/private/tmp/synara-cua-implementation/revision-40 \
SYNARA_CUA_FIXTURE_DRIVER=/private/tmp/cua-stage/cua-driver \
SYNARA_CUA_FIXTURE_FOREGROUND=approved-once \
SYNARA_CUA_FIXTURE_FOREGROUND_CANCEL=approved-once \
'/private/tmp/Synara Cua Fixture.app/Contents/MacOS/Electron'
```

GUI fixtures must run sequentially. Independent application/OS readback and
passive focus evidence determine their result; a transport reply alone does not.
