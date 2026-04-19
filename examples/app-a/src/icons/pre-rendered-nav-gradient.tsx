// @ts-nocheck — this file is a source fixture scanned by the analyzer,
// not compiled. JSX runtime types are not installed in the examples
// tree; suppressing type-check so the editor stays clean.
//
// Duplicate-static-SVG-id fixture (P6, v2 per D10).
//
// Reproduces the nav-gradient incident: originally the sub-nav for each
// category was rendered lazily on user click, so only ever one instance
// of `<CategoryIcon />` existed in the DOM at a time. When the product
// moved to SSR / SSG pre-rendering so that every category's sub-nav
// would be indexable by crawlers, every rendered instance was emitted
// into the same document. Every instance declares <linearGradient
// id="category-icon-fx"> and references it via fill="url(#category-
// icon-fx)"; the browser resolves every reference to whichever copy it
// saw first, so every category after the first renders with the wrong
// (or missing) gradient.
//
// Under v2 (D10 — "describe what is, don't predict what could be"), a
// lone `<CategoryIcon />` in this file on its own is NOT a finding —
// the analyzer can only see one declaration site and cannot prove it
// renders multiple times. The evidence that pushes this into an actual
// finding lives in `nav-grid.tsx`, which imports `CategoryIcon` and
// renders it inside `items.map(...)`. That caller-loop is observable
// and demonstrates actual multi-render.
//
// Expected output: ONE finding with
//   - kind           'duplicate-static-svg-id'
//   - id             'category-icon-fx'
//   - component      'CategoryIcon'
//   - evidence[]     contains a `caller-loop` entry pointing at nav-grid.tsx
//   - occurrences[]  has declare (this file) + reference (this file) +
//                    iteration-site (nav-grid.tsx)
//
// The `SafeCategoryIcon` component at the bottom is the passing shape
// that must NOT trigger: it derives the id per instance via useId() and
// threads it into both the declaration and the reference. It is not
// imported by nav-grid.tsx either, so nothing even considers it as a
// candidate.
//
// Note: this file is a fixture scanned as source by the analyzer; it is
// not compiled or executed. `useId` is declared as an ambient symbol so
// the fixture parses cleanly without pulling React types into the
// examples tree.

declare const useId: () => string;

export function CategoryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="category-icon-fx" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#category-icon-fx)" />
    </svg>
  );
}

// Safe counterpart — React.useId gives every render a unique id, which
// means every rendered instance paints with its own gradient. Must NOT
// be flagged.
export function SafeCategoryIcon() {
  const gid = useId();
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill={`url(#${gid})`} />
    </svg>
  );
}
