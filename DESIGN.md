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

The interface is rendered in the sx-glass L2 neumorphic glass language: 132.39° white-to-gray gradient panels, `blur(13.44px) saturate(135%)`, multi-layer neumorphic shadows, a rim light and a top halo band on every panel, pill (100px) geometry for controls, and Inter italic 800 for headings and labels. The page field is the product photo `public/background.jpg` (2048×1152, 456 KB JPEG at quality 92, from a 3.3 MB source PNG) laid over flat `#cfcfcf`, so the panels refract against a real image instead of a flat gray. The photo is `background-size: cover` on a fixed layer, centred (`background-position: center`): a 16:9 source fits a portrait phone and a wide window vertically, so only the horizontal anchor matters, and centring keeps the ridge in frame on every screen. The layer carries **no `filter`** — on the previous photo, measured adjacent-pixel detail was `1.815` unfiltered versus `0.836` with the old `blur(1.5px)`.

The whole-page scrim is deliberately the simplest thing that works: `body::after` is one fixed layer with `background: rgba(255,255,255,0.58)` — no `mix-blend-mode`, no mask, no second colour. It lifts the whole picture uniformly toward white, which keeps body text `#14141c` at `6.28:1` on a phone and `6.69:1` on a desktop (the alpha band was measured: `0.55` gives 5.74–6.11:1, `0.62` gives 7.09–7.46:1, so `0.58` is the smallest sheet that clears the `6:1` line below which text reads fuzzy). Secondary `#2b3038` sits at 6.03–6.43:1, user messages 4.90:1, labels 4.84:1, errors 4.65:1 — all above AA.

The cost is saturation, not hue: a uniform veil mixes white into every pixel, so the photo keeps its composition and colour family (hue rotation `3.4°`) but retains `42%` of its chroma and `65%` of its texture. An earlier revision used a masked `screen` lift generated from the photo's own luminance, which kept `70%` of the phone's pixels byte-identical and `88%` of its texture where it acted; it was replaced by this three-line version on the user's explicit request, and this paragraph records what that trade was so the decision can be reversed knowingly. Text surfaces stay fully transparent — transcript entries, the session header and the empty state all compute `background: rgba(0, 0, 0, 0)` — and no glyph carries a `text-shadow` halo (an earlier revision did, and that halo is what made text look blurred). `prefers-reduced-transparency` and `prefers-contrast: more` raise the veil to `--bg-scrim-veil-solid` (`rgba(255,255,255,0.72)`). The photo layer uses a negative z-index, so `body` must stay `transparent` and the base colour sits on `html`: an opaque body background paints over negative-z children and hides the photo completely.
## Popovers share one material

Anything that only appears after a click — the model picker, the reasoning picker, the
auto-approve settings — is a `.glass-popover`, and that class is the same material as
`.create-sheet`: `--glass-bg-strong` fill, `blur(20px) saturate(140%)`, a `1.92px`
`rgba(171,171,171,.8)` edge, and the shared rim light plus halo band that every card and
button in this UI already carries. Before this, the auto-approve panel carried its own
1px white edge and an 18px radius, so it read as a different design; the model and
reasoning selects were native, and a native `<select>` popup is drawn by the OS and can
never match.

The controls inside follow the same rule: durations are a segmented pill group, scopes are
a knob switch, and the confirm action is the shared `.primary-button`. Both keep the native
`<input type="radio">` / `checkbox` in the DOM (visually hidden) so keyboard and semantics
are untouched, and the check/countdown is pure CSS.

**Placement is viewport-based, not container-based.** A popover used to be
`position: absolute; right: 0`, which anchors it to its trigger's containing block — and on
a phone the auto-approve trigger is only ~110px wide inside a flex row, so a 320px panel
spilled off the left edge of the screen. The panel is now `position: fixed` and placed by
script when it opens: measured at a safe origin, right-aligned to the trigger, then clamped
on **both** axes to `8px` inside the viewport, flipping above the trigger when there is no
room below, and scrolling the trigger into view first if the trigger itself is off-screen.
`max-width: calc(100vw - 16px)` / `max-height: calc(100dvh - 16px)` keep that guarantee even
if the script never runs. Rotation, resize and any scroll reposition whatever is open, so a
panel follows its trigger instead of drifting away from it.

The pickers keep the native `<select>` as the single source of truth — `renderModelControl`
and the change handler still read it — but it is hidden and a glass trigger plus a list panel
does the talking, with a filter once a list passes twelve entries (one DSH install reports
242 models). Keyboard and pointer both work: click outside or `Esc` closes, selecting a row
sets the select's value and dispatches `change`, so nothing downstream knows the panel exists.
## One recipe per role in the drawer

The drawer holds four things that arrived from four different places, so it used to show four
styles: agent rows, session rows, the phone-notification block and the two footer buttons.
Each row class had its own padding and radius, the rows had no hover state at all, and the
notification block was a bespoke `rgba(255,255,255,.46)` pill with a `1px` white edge and a
`14px` radius — next to cards made of `1.92px rgba(171,171,171,.8)` and `--panel-shadow` it
read as a different product.

There is now exactly one recipe per role:

- **Rows** — `.drawer-agent`, `.drawer-session` and `.drawer-deep-hit` share
  `min-height: 46px; padding: 8px 10px; border-radius: 14px; background: transparent`, hover at
  `rgba(255,255,255,.38)`, and a `--glass-bg` fill plus an inner ring when selected or
  expanded. A row is a row, whichever list it lives in.
- **Cards** — `.drawer-card` *is* the card material: `--glass-bg-strong`,
  `blur(20px) saturate(140%)`, `1.92px rgba(171,171,171,.8)`, `--panel-shadow`, a `20px` radius,
  and membership in the shared rim / halo / child-z-index selector lists. Its title is `12px`
  italic `800` in `--ink` and its note is `11px` in `--ink-2`, clipped with an ellipsis so a long
  hint never widens the drawer.
- **Switches** — the notification switch is `class="secondary-button notify-switch"`. It
  inherits the fill, inner ring and mini shadow from the shared secondary button and only
  overrides `min-height`/`padding`; the only thing it adds is an amber tint while muted. Before,
  it drew its own `1.6px` grey edge.
- **Footer** — both buttons are `flex: 1 1 0` at `44px` tall, so they are always equal, and when
  history sync is unavailable the remaining button fills the whole row instead of leaving half
  of it empty.

`verify:navigation` asserts all of this at 1440×1000 and 390×844: the three row radii must be
identical, the card's border colour, border width and blur must equal `.create-sheet`'s
exactly, the card must be round at `20px` and carry a shadow, the drawer must not scroll
sideways, the switch's computed background and inner ring must equal a freshly inserted
`.secondary-button`'s, and the footer buttons must be equal — with a lone button measured at
full row width. At 320×568 the same audit checks the card still fits inside the drawer
(263px of 288px) and the switch stays at least `44px` tappable.
## Away-from-desk surfaces

Four interaction patterns exist only because the user is not at the keyboard, and each
follows the same rule: the phone must never be asked to guess or to babysit.

- **Notifications** (`.notifier`): `approval.requested`, `input.requested`,
  `turn.completed`, `turn.failed`, `session.failed` are pushed to a webhook. Best
  effort by contract — a dead endpoint is logged, never surfaced as a failed turn —
  and damped to one per conversation+kind per 15 seconds so a long turn cannot spam.
- **Time-boxed blanket approval**: a server-enforced window (max 30 minutes, explicit
  tool scope, only by the device holding the input lease) that answers matching
  approvals for you and records each one as `已自动放行（限时策略）`. The armed state is a
  live countdown pill, and expiry is checked against the clock on every use rather
  than by a timer that might not fire.
- **Queueing**: a message typed while a turn runs is queued, listed as `第 N 位`, and
  cancellable, instead of being refused. Five deep.
- **Attachments**: the composer uploads raw bytes to the bridge, which stores them
  under the data directory and hands the provider what it can consume — an image
  content block for Claude and ACP, an absolute path for Codex and DSH Desktop.

The shell is content-addressed (`/app.js?v=<hash>`, `/styles.css?v=<hash>`, and the
stylesheet versions its own photo) so a phone caches it for a year while `index.html`
stays `no-store`: correctness comes from the hash changing, not from forbidding the
cache.
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
