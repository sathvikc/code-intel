// @ts-nocheck — fixture scanned by the analyzer, not compiled.
//
// Caller fixture for the duplicate-static-svg-id detector (v2, D10).
//
// This file imports `CategoryIcon` from `./pre-rendered-nav-gradient`
// and renders it inside `items.map(...)`. That caller-loop is the
// evidence the detector uses to upgrade `CategoryIcon` from "static id
// + anchor, no visible multi-render" to a real finding (E2 caller-loop).
//
// Without this file, v2 would correctly emit NOTHING for the lone
// CategoryIcon component — see the long-form comment in
// pre-rendered-nav-gradient.tsx.

import { CategoryIcon } from './pre-rendered-nav-gradient';

type Category = { id: string; label: string };

export function NavGrid({ categories }: { categories: Category[] }) {
  return (
    <nav aria-label="category-grid">
      {categories.map((c) => (
        <a key={c.id} href={`/c/${c.id}`} className="nav-tile">
          <CategoryIcon />
          <span>{c.label}</span>
        </a>
      ))}
    </nav>
  );
}
