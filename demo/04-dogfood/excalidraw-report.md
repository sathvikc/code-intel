<!--
  Provenance:
    Source         excalidraw/excalidraw @ main (shallow sparse clone)
    Scope          excalidraw-app/  (the SPA that ships to excalidraw.com)
    Command        node src/cli.js impact /tmp/.../excalidraw-app --markdown
    Runtime        ~1.28 seconds
    Output         Verbatim — no findings were suppressed, no cherry-picks.

  See demo/04-dogfood/README.md for the curated walkthrough of the
  highest-signal findings below and a reproduction recipe.
-->

# code-intel — Impact Report
_2026-04-18 07:31:07_

## Summary

- **Findings:** 42 total
- **By severity:** 🔴 1 critical · 🟡 41 warning · 🔵 0 info
- **By confidence:** 1 high · 5 medium · 36 low
- **By kind:** Shared global binding: 1 · Shared event channel: 17 · Shared storage key: 20 · Stale module-scope capture: 4

## Findings

### 🔴 Critical (1)

#### Shared global binding

- **`shared-global-binding:visualDebug`** `high confidence` — Global name 'visualDebug' declared by 2 files
  > Global name 'visualDebug' is declared or assigned by 2 files. At runtime, whichever script loads last silently overwrites the earlier definition. The browser gives no warning; TypeScript and ESLint do not see across classic-script boundaries. The coupling is certain; the only question is which definition wins in your production load order.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 428 | `assign` |
  | `excalidraw-app` | `App.tsx` | 432 | `remove` |
  | `excalidraw-app` | `components/AppMainMenu.tsx` | 67 | `remove` |
  | `excalidraw-app` | `components/AppMainMenu.tsx` | 70 | `assign` |

### 🟡 Warning (41)

#### Shared event channel

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.HASHCHANGE) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 635 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 636 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.BLUR) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 637 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.FOCUS) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 639 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.HASHCHANGE) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 641 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 642 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.BLUR) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 643 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.FOCUS) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 644 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.BEFORE_UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 672 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.BEFORE_UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 674 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.BEFORE_UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `collab/Collab.tsx` | 209 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `collab/Collab.tsx` | 212 | `listen` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.BEFORE_UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `collab/Collab.tsx` | 263 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.UNLOAD) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `collab/Collab.tsx` | 264 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.POINTER_MOVE) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `collab/Collab.tsx` | 265 | `unlisten` |

- **`shared-event-channel:anon`** `low confidence` — CustomEvent channel (dynamic: EVENT.VISIBILITY_CHANGE) used by 1 files
  > The event channel name is computed at runtime. The analyzer has recorded a dynamic dispatch or listener site; whether this channel actually collides with another site depends on what the expression evaluates to. Audit the site and decide if it needs a stable channel name.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `collab/Collab.tsx` | 266 | `unlisten` |

- **`shared-event-channel:beforeinstallprompt`** `medium confidence` — CustomEvent channel 'beforeinstallprompt' used by 1 files
  > CustomEvent channel 'beforeinstallprompt' has 1 file(s) touching it with ops listen. The coupling is plausible but one-sided — e.g. a listener with no visible dispatcher may mean the dispatcher is in code the analyzer did not scan, or the event is fired by a library.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `App.tsx` | 179 | `listen` |

#### Shared storage key

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_APP_STATE) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `ExcalidrawPlusIframeExport.tsx` | 179 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `ExcalidrawPlusIframeExport.tsx` | 182 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_THEME) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `useHandleAppTheme.ts` | 15 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_THEME) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `useHandleAppTheme.ts` | 58 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/LocalData.ts` | 90 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_APP_STATE) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/LocalData.ts` | 94 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.__LEGACY_LOCAL_STORAGE_LIBRARY) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/LocalData.ts` | 262 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.__LEGACY_LOCAL_STORAGE_LIBRARY) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/LocalData.ts` | 275 | `remove` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_COLLAB) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 13 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_COLLAB) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 25 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 42 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_APP_STATE) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 43 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 78 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_APP_STATE) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 89 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_COLLAB) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/localStorage.ts` | 90 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: type) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/tabSync.ts` | 13 | `read` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: type) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/tabSync.ts` | 20 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: key) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `data/tabSync.ts` | 33 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_DEBUG) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `components/DebugCanvas.tsx` | 399 | `write` |

- **`shared-storage-key:anon`** `low confidence` — localStorage key (dynamic: STORAGE_KEYS.LOCAL_STORAGE_DEBUG) is touched by 1 files
  > The storage key is computed at runtime, so occurrence grouping is heuristic — two dynamic sites that happen to share the same dynamic-site fingerprint may or may not reference the same logical key. Treat this finding as "a dynamic storage site worth auditing" rather than a concrete coupling claim.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `components/DebugCanvas.tsx` | 422 | `read` |

#### Stale module-scope capture

- **`stale-module-capture:getStorageSizes`** `medium confidence` — 'getStorageSizes' captures dynamic source at module scope (via getElementsStorageSize)
  > Module-scope capture of a dynamic source (getElementsStorageSize). This is a bug in runtime models where modules persist across state changes: single-page apps (React Router, Vue Router, Svelte navigation), SSR client bundles after hydration, web and service workers, and long-running Node services. It is lower-risk in classic multi-page apps (full page reload on every navigation), static-site builds, and CLI tools. Check how 'getStorageSizes' is read — if any caller runs after the captured value could have changed, the stale value will be returned.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `CustomStats.tsx` | 24 | `` |

- **`stale-module-capture:isExcalidrawPlusSignedUser`** `medium confidence` — 'isExcalidrawPlusSignedUser' captures dynamic source at module scope (via document.cookie)
  > Module-scope capture of a dynamic source (document.cookie). This is a bug in runtime models where modules persist across state changes: single-page apps (React Router, Vue Router, Svelte navigation), SSR client bundles after hydration, web and service workers, and long-running Node services. It is lower-risk in classic multi-page apps (full page reload on every navigation), static-site builds, and CLI tools. Check how 'isExcalidrawPlusSignedUser' is read — if any caller runs after the captured value could have changed, the stale value will be returned.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `app_constants.ts` | 59 | `` |

- **`stale-module-capture:onlineEnv`** `medium confidence` — 'onlineEnv' captures dynamic source at module scope (via window.location)
  > Module-scope capture of a dynamic source (window.location). This is a bug in runtime models where modules persist across state changes: single-page apps (React Router, Vue Router, Svelte navigation), SSR client bundles after hydration, web and service workers, and long-running Node services. It is lower-risk in classic multi-page apps (full page reload on every navigation), static-site builds, and CLI tools. Check how 'onlineEnv' is read — if any caller runs after the captured value could have changed, the stale value will be returned.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `sentry.ts` | 14 | `` |

- **`stale-module-capture:rootElement`** `medium confidence` — 'rootElement' captures dynamic source at module scope (via document.getElementById())
  > Module-scope capture of a dynamic source (document.getElementById()). This is a bug in runtime models where modules persist across state changes: single-page apps (React Router, Vue Router, Svelte navigation), SSR client bundles after hydration, web and service workers, and long-running Node services. It is lower-risk in classic multi-page apps (full page reload on every navigation), static-site builds, and CLI tools. Check how 'rootElement' is read — if any caller runs after the captured value could have changed, the stale value will be returned.
  | Project | File | Line | Op |
  | :--- | :--- | ---: | :--- |
  | `excalidraw-app` | `index.tsx` | 10 | `` |
