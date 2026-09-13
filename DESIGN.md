---
version: alpha
name: AgentBridge
description: A mobile-first engineering duty handover ledger for safely following and controlling local coding agents.
colors:
  paper: "#f4efe3"
  paper-strong: "#fffdf7"
  ink: "#19232d"
  ink-soft: "#5b6670"
  rule: "#d6ccbb"
  blue: "#1558a6"
  blue-dark: "#0d3e78"
  blue-soft: "#dceafb"
  amber: "#9a4d06"
  amber-soft: "#fff0ce"
  red: "#a42e2e"
  red-soft: "#fbe5df"
  green: "#18704b"
  focus: "#006edb"
  ink-reverse-soft: "#d9d5cb"
  link-on-dark: "#b9d7ff"
  field-border: "#b8af9f"
  composer-border: "#aaa08e"
  codeblock-bg: "#202a33"
  codeblock-ink: "#f5f1e8"
  codeblock-border: "#c9c0b2"
  scrollbar-thumb: "#a89e8d"
typography:
  pairing-display:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "64px"
    fontWeight: 700
    letterSpacing: "-0.04em"
  empty-display:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "54px"
    fontWeight: 700
    letterSpacing: "-0.04em"
  session-headline:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "38px"
    fontWeight: 700
    letterSpacing: "-0.035em"
  rail-title:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "30px"
    fontWeight: 700
    letterSpacing: "-0.035em"
  body:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.62
  body-small:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei UI", ui-sans-serif, sans-serif'
    fontSize: "11px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  brand-mark: "9px"
  control: "10px"
  send: "11px"
  compact-surface: "12px"
  surface: "14px"
  pairing-mark: "16px"
spacing:
  control-gap: "8px"
  compact-inset: "10px"
  field-inset: "12px"
  mobile-gutter: "16px"
  section-inset: "24px"
  conversation-inset: "28px"
  airy: "40px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "white"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.blue-dark}"
  button-secondary:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue-dark}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "44px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.red}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "44px"
  button-danger-confirming:
    backgroundColor: "{colors.red}"
    textColor: "white"
  button-icon:
    backgroundColor: "{colors.blue}"
    textColor: "white"
    rounded: "{rounded.compact-surface}"
    width: "44px"
    height: "44px"
  button-send:
    backgroundColor: "{colors.blue}"
    textColor: "white"
    rounded: "{rounded.send}"
    width: "48px"
    height: "48px"
  input-field:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  approval-entry:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "14px"
---

# Design System: AgentBridge

## Overview

**Creative North Star: "工程值班交接簿"**

AgentBridge should feel like a bright, dependable duty ledger shared between an engineer at the desk and the same engineer on a phone. Warm paper, dark ink, fine ruled separators, terse metadata, and a chronological event record make the interface feel inspectable and operational rather than promotional.

The system is deliberately flat, text-led, and continuous. It uses blue ink for agency and current selection, reserves warm alert colors for exceptional state, and avoids the generic SaaS pattern of arranging every fact in a separate floating card. Density is compact enough for active supervision but keeps Chinese copy readable and every control reachable on a small touch screen.

**Key Characteristics:**

- Warm paper surfaces with high-contrast engineering ink.
- A continuous, ruled timeline instead of chat bubbles or a card matrix.
- Blue signals agency, selection, and operator-authored content.
- Status is always communicated with words as well as color.
- Mobile-first controls with a minimum 44px touch target.

## Colors

The palette behaves like ink on a duty ledger: warm neutrals carry nearly the whole screen, while one blue family handles interaction and narrowly scoped semantic colors report state.

### Primary

- **Action Blue** (`blue`): The solid fill for primary, send, and add actions, and the active marker for the selected session.
- **Command Blue** (`blue-dark`): Hovered primary actions, metadata emphasis, operator-authored messages, and text on pale-blue controls.
- **Control Wash** (`blue-soft`): Secondary controls and the quiet selected-session wash.
- **Focus Blue** (`focus`): The keyboard focus outline and focused composer border; it is brighter than the normal action ink so focus remains unmistakable.

### Neutral

- **Duty Ledger Paper** (`paper`): The page field and default app canvas.
- **Fresh Sheet** (`paper-strong`): Input and composer surfaces plus reverse-text support on the dark pairing strip.
- **Operations Ink** (`ink`): Headlines, body copy, the brand block, and the dark pairing surface.
- **Muted Graphite** (`ink-soft`): Timestamps, helper copy, machine identity, and secondary event output.
- **Ledger Rule** (`rule`): One-pixel dividers, row boundaries, and the 32px writing-line rhythm behind the event stream.

### Supporting Tones

- **Reverse Muted** (`ink-reverse-soft`): Secondary copy sitting on the dark pairing strip.
- **Link on Dark** (`link-on-dark`): URLs and code strings on the dark pairing strip.
- **Field/Composer Borders** (`field-border`, `composer-border`): Warm-gray strokes on inputs and the composer.
- **Codeblock** (`codeblock-bg`, `codeblock-ink`, `codeblock-border`): The dark code surface and its border inside rendered markdown.
- **Scrollbar Thumb** (`scrollbar-thumb`): The muted scrollbar grip.

### Semantic Status

- **Waiting Amber** (`amber`) and **Approval Wash** (`amber-soft`): Starting/running indicators and approval requests that require attention but do not yet represent failure.
- **Risk Red** (`red`) and **Refusal Wash** (`red-soft`): Failures, offline state, stop confirmation, errors, and denial actions.
- **Synchronized Green** (`green`): Ready and online state only.

**The Blue-Is-Agency Rule.** Use blue for an available action, the current selection, or operator-authored content; do not spend it as ambient decoration.

**The Warm-Color Budget Rule.** Amber means waiting or approval, and red means risk, failure, denial, or destructive confirmation. Neither color is a general accent.

## Typography

**Display Font:** IBM Plex Sans with Noto Sans SC, Microsoft YaHei UI, and system sans-serif fallbacks.

**Body Font:** The same stack, preserving consistent Chinese metrics and an engineering-tool tone.

**Character:** A single practical sans-serif family carries the interface. Hierarchy comes from scale, weight, compressed tracking on headings, and spaced technical labels rather than from a decorative display face.

### Hierarchy

- **Pairing Display** (`pairing-display`): The largest connection-state headline; its implemented size is fluid from 34px to the token's 64px maximum.
- **Empty Display** (`empty-display`): Empty-state guidance; it scales from 28px to the token's 54px maximum.
- **Session Headline** (`session-headline`): The active task title; it scales from 24px to the token's 38px maximum.
- **Rail Title** (`rail-title`): The stable 30px session-list heading.
- **Body** (`body`): Event prose and explanatory copy, with timeline content capped at 72 characters and empty-state copy at 52 characters.
- **Body Small** (`body-small`): Tool events, connection state, captions, and form guidance.
- **Metadata** (`metadata`): Adapter/project labels and event labels; uppercase Latin content, firm weight, and tabular numerals for timestamps.

**The One-Family Rule.** Do not introduce a display or monospace font merely to manufacture hierarchy; use the established sans stack and its weight, size, and tracking shifts.

**The Timestamp Stability Rule.** Use tabular numerals for connection data and timestamps so the chronological rail does not jitter as values change.

## Layout

The desktop shell is a fixed-max-width ledger: a sticky 66px top bar spans the viewport, while pairing and workspace content stop at 1180px. The workspace uses a 250–310px session rail beside one flexible conversation column, with a 26px outer rhythm. The rail is separated by a single rule, not wrapped in a card. Conversation content begins 28px past that seam; event entries use a 74px time column and a flexible body column.

The event stream is the spatial backbone. A repeating horizontal rule lands every 32px, entries sit directly on that field, and the desktop log may scroll independently below the session header. New events follow the tail only when the reader is already within 80px of it; inspecting older entries must not be interrupted by forced scrolling.

At the 780px breakpoint, the layout becomes one column. The machine name disappears, sessions become a horizontal strip with 220px minimum-width rows, the active marker moves from the left edge to the bottom edge, and the session header stacks actions below the title. The time column contracts to 52px, page gutters become 16px, the event log returns to document flow, and the composer becomes a sticky edge-to-edge bottom control that includes the device safe-area inset.

The page prevents horizontal viewport overflow. Long URLs and event content wrap anywhere where necessary, while intentional horizontal scrolling is isolated to the mobile session strip. Buttons and selects never fall below 44px; the send control is 48px square.

**The One Continuous Record Rule.** Keep session details and agent activity in one readable vertical sequence; do not break the record into a dashboard grid of summary cards.

## Elevation & Depth

This is a flat system. Hierarchy comes from paper-tone changes, ink reversal, one-pixel rules, and inset active markers. Shadows appear only where state or viewport separation needs extra clarity: the focused composer lifts slightly, the toast floats above the page, and the active session uses an inset blue rule rather than an ambient card shadow.

### Shadow Vocabulary

- **Composer Focus Lift** (`0 5px 18px color-mix(in srgb, var(--ink) 10%, transparent)`): Appears only while the composer contains focus.
- **Toast Float** (`0 8px 28px rgba(25,35,45,.24)`): Separates the temporary alert from the page.
- **Active Session Rule** (`inset 3px 0 0 var(--blue)` desktop; `inset 0 -3px 0 var(--blue)` mobile): Marks location, not physical elevation.

**The Flat-by-Default Rule.** Resting surfaces stay shadowless; a shadow must communicate focus, overlay, or current location.

## Shapes

Corners are gently engineered rather than pillowy. Compact identity marks use 9px rounding, fields and standard buttons use 10px, the send control uses 11px, compact containers use 12px, and the recurring content surface uses 14px. The larger pairing mark alone reaches 16px. Circular geometry is reserved for status dots.

Most structure remains rectilinear through one-pixel ledger rules. Rounded surfaces are reserved for bounded controls, the approval request, toast, QR panel, and pairing strip; ordinary timeline entries and desktop session rows do not become cards.

**The Bounded-Radius Rule.** Use rounding to identify a control or exceptional bounded surface, never to turn every content group into a capsule or card.

## Components

### Buttons

- **Shape:** Standard action buttons use the gently curved control radius and at least 44px height; the send action is a 48px square.
- **Primary:** Solid Action Blue with white text and strong weight. Its implemented hover state deepens to Command Blue.
- **Secondary:** Control Wash with Command Blue text and icon, used for taking input control without implying danger.
- **Danger:** Transparent with Risk Red text and a mixed red/paper border. For an active turn, the first stop press opens a five-second confirmation state with a solid red fill and the label “再次点击确认”; the second press sends the stop request.
- **Focus / Disabled:** Every button receives a visible three-pixel focus outline offset by two pixels. Disabled controls retain their geometry, drop to 48% opacity, and use a not-allowed cursor.
- **Visibility boundary:** Stop is hidden unless the session is running and disabled when this device lacks control. “接管输入” appears only when another device currently owns the lease; a session with no owner acquires control on its first sent message.

### Inputs / Fields

- **Style:** Selects and single-line fields use Fresh Sheet, a warm-gray one-pixel stroke, the control radius, 12px horizontal inset, and 44px height.
- **Composer:** The textarea lives inside a Fresh Sheet container with the surface radius, a warm one-pixel border, 10px inset, and a dedicated 48px send button. It grows from 48px to 160px before stopping.
- **Focus:** Individual fields receive the global focus outline. Inside the composer, the textarea outline is suppressed and the container instead shifts to Focus Blue with the composer focus lift.
- **Control boundary:** Sending is disabled while the Agent is running or another device owns the lease. Placeholder copy must explain whether the Agent is running, first-send control is available, this device owns control, or takeover is required.

### Navigation

Session navigation is a list of ledger rows, not navigation cards. Desktop rows are at least 72px high with a status dot, truncated title, technical metadata, a bottom rule, and a three-pixel blue inset on the active row. Mobile rows become bordered 220px-wide items in a horizontal strip, and the active inset moves to the bottom. The active button carries `aria-current="true"`; the status dot's accessible label mirrors the Chinese status text shown in metadata.

### Event Timeline

Every event is an article aligned to a stable timestamp column. Labels use Command Blue, ordinary prose uses Operations Ink, user-authored text becomes heavier Command Blue, tool output recedes to Muted Graphite, and failures become Risk Red. The event log itself uses `aria-live="off"`; a separate polite, atomic announcer reports new completed messages and status updates so rerendering the log does not duplicate speech.

### Approval Request

Approval is the one inline event that gains a bounded surface: Approval Wash, the surface radius, and 14px inset. “仅本次批准” uses the primary action treatment; “拒绝” uses Refusal Wash and Risk Red. The amber background signals waiting, while explicit heading and button text carry the meaning without color.

### Connection and Session Status

Connection state pairs an eight-pixel colored dot with text: “实时同步”, “正在连接”, or “正在重连”. Session rows likewise pair the dot with a Chinese status label such as “启动中”, “就绪”, “执行中”, “失败”, or “离线”. Color is reinforcement, never the sole status channel.

### Pairing Strip

The desktop pairing invitation is a single dark Operations Ink strip with reversed Fresh Sheet text, a pale-blue URL, and one QR block. It is intentionally prominent and singular. On mobile it stacks vertically with 14px viewport margins, and the long pairing URL can wrap anywhere.

## Do's and Don'ts

### Do:

- **Do** preserve the warm paper field and continuous ruled chronology across new supervision screens.
- **Do** keep every touch control at least 44px and provide a visible keyboard focus state.
- **Do** pair every colored status mark with readable Chinese status text.
- **Do** let users read older events without snapping them to the newest event unless they were already following the tail.
- **Do** reserve the 780px breakpoint for the implemented single-column, horizontal-session-strip mobile transformation.

### Don't:

- **Don't** replace the timeline with chat bubbles or a generic SaaS card matrix.
- **Don't** use amber or red as decorative brand accents; they are reserved for waiting/approval and risk/failure/destructive confirmation.
- **Don't** show controls an adapter or lease state cannot support, and do not rely on disabled styling alone when the action should be absent.
- **Don't** allow long URLs, commands, or event text to create page-level horizontal overflow.
- **Don't** add ambient shadows to resting rows, panels, or ordinary event entries.
