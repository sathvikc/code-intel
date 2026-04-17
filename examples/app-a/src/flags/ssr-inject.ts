// app-a/src/flags/ssr-inject.ts
//
// Stand-in for the inline <script> the Astro SSR layer emits into the
// page head for feature flags. In production this renders as:
//
//   <script>sessionStorage.setItem('flags', '{"newOnboarding":true,...}')</script>
//
// …so flags are present in sessionStorage before any bundle loads. The
// fixture expresses the same effect in a .ts file so the analyzer sees
// the sessionStorage write statically. (Parsing Astro frontmatter /
// <script> blocks directly is a backlog item.)

declare const __SSR_FLAGS_PAYLOAD__: string;

export function applySsrInjectedFlags(): void {
  // On the server, __SSR_FLAGS_PAYLOAD__ is serialised from the API
  // response. On the client, this function stands in for the inline
  // script that runs before hydration.
  sessionStorage.setItem('flags', __SSR_FLAGS_PAYLOAD__);
}
