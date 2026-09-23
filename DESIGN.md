---
version: alpha
name: AgentBridge (sx-glass skin)
description: A mobile-first engineering duty console re-skinned with the sx-glass L2 component parameters (neumorphic frosted glass, pill geometry, italic 800 labels).
colors:
  ink: "#2a2a3a"
  ink-2: "rgba(0,0,0,0.6)"
  ink-3: "rgba(0,0,0,0.45)"
  line: "rgba(0,0,0,0.08)"
  accent: "rgba(0,140,220,0.9)"
  accent-bright: "rgba(0,179,255,0.9)"
  ok: "rgba(0,170,140,0.85)"
  warn: "rgba(220,150,0,0.85)"
  err: "rgba(220,60,60,0.85)"
  focus: "rgba(0,179,255,0.35)"
  field: "#cfcfcf"
typography:
  display:
    fontFamily: '"Inter", "Noto Sans SC", "Microsoft YaHei UI", system-ui, ui-sans-serif, sans-serif'
    fontWeight: 800
    fontStyle: italic
    letterSpacing: "-0.04em"
  label:
    fontFamily: '"Inter", "Noto Sans SC", "Microsoft YaHei UI", system-ui, ui-sans-serif, sans-serif'
    fontSize: "11px"
    fontWeight: 800
    fontStyle: italic
    letterSpacing: "0.06em"
  body:
    fontFamily: '"Inter", "Noto Sans SC", "Microsoft YaHei UI", system-ui, ui-sans-serif, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.62
rounded:
  panel: "20px"
  pill: "100px"
  row: "16px"
  alert: "25px"
spacing:
  control-gap: "10px"
  panel-inset: "24px"
  mobile-gutter: "10px"
---

# Design System: AgentBridge (sx-glass skin)

## Overview

**Source of truth: `D:\ocean-glass-ui\sx-glass-component-kit-v2.html` (sx-glass L2).**

The interface is rendered in the sx-glass L2 neumorphic glass language: 132.39° white-to-gray gradient panels, `blur(13.44px) saturate(135%)`, multi-layer neumorphic shadows, a rim light and a top halo band on every panel, pill (100px) geometry for controls, and Inter italic 800 for headings and labels. The page field is flat `#cfcfcf` gray so the glass refracts against it.

## The Base Recipe (`.sx-glass` equivalent)

Every floating panel combines:

- **Fill:** `linear-gradient(132.39deg, rgba(255,255,255,0.474) 15.21%, rgba(128,128,128,0.412) 89.39%)` (`--glass-bg`); stronger variant `--glass-bg-strong` for inputs and the composer.
- **Blur:** `--glass-blur` = `blur(13.44px) saturate(135%)` (with `-webkit-` prefix).
- **Shadow:** `--panel-shadow` — the 8-layer stack (two 36px ambient, six inset).
- **Rim (`::before`):** `inset 0 1px 0 white`, `inset 0 -1px 0 rgba(0,0,0,.45)`, `inset 1px 0 0 rgba(255,255,255,.36)`, `inset -1px 0 0 rgba(0,0,0,.24)`.
- **Halo (`::after`):** the `--halo` horizontal white band, 2px tall, inset 3px/24px from the top edge.
- **Mini variant:** `--mini-shadow` (4-layer) for rows, fields, and small controls.

## Controls

- **Buttons** (`.primary-button` etc.): pill shape, 1.92px `rgba(171,171,171,1)` border, white→blue `linear-gradient(132deg, rgba(255,255,255,.48), rgba(0,119,179,.41))`, `--btn-shadow`, italic 800 12px; hover lifts `translateY(-2px) scale(1.02)`, active presses `scale(0.97)` with pure inset shadow. Primary adds a `rgba(0,179,255,.25)` blue wash; secondary is the ghost variant; danger uses the red glass ramp.
- **Icon / send buttons:** circular pills with the deeper icon-button shadow stack.
- **Fields:** pill inputs and the composer are glass containers; inner controls are transparent. Focus is a `0 0 0 3px var(--focus)` glow, never a bare outline.
- **Tags/status:** italic 800 pills with a 6–8px status dot. Dots use ok/warn/err; color always pairs with Chinese status text.

## Layout

Unchanged from the structural spec: sticky pill top bar (max 1180px), pairing panel, session rail (250–310px) beside one conversation column, and the 780px single-column mobile transformation with a horizontal session strip and a sticky floating composer (10px margins, 20px radius).

The event timeline keeps its time-column article rows but drops the ruled-line background; emphasis comes from italic accent labels and the ink scale.

## Status & Semantics

- **Blue (`accent`)**: agency, links, current selection, event labels.
- **Amber (`warn`)**: starting/running and approvals. **Red (`err`)**: failure, offline, destructive. **Green (`ok`)**: ready/online only.
- Approval entries use the sx-alert recipe: 25px radius, `176deg` pale gradient, 1.92px gray border, elevated inset shadows.

## Do's and Don'ts

- **Do** keep every panel on the full base recipe — fill, blur, shadow, rim, and halo travel together.
- **Do** keep touch targets ≥44px and the focus glow on every interactive element.
- **Do** pair every colored status dot with readable Chinese status text.
- **Don't** mix in the retired warm-paper ledger palette (`#f4efe3`, `#1558a6`, …); it was replaced wholesale.
- **Don't** put rim/halo pseudo-elements on raw form controls — the kit assigns them to containers (`.sx-glass-field` pattern).
- **Don't** animate layout properties; button motion is transform/filter only, and `prefers-reduced-motion` removes hover lift and the loader sweep.
- **Don't** rely on blur for legibility: `prefers-reduced-transparency` and no-`backdrop-filter` browsers get solid `#eceef1` fills.
