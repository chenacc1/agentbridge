# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the implementation request: Node.js ESM backend with a dependency-light static HTML/CSS/JavaScript mobile web client. The MVP runs locally on Windows and is opened by scanning an HTTPS or LAN HTTP URL in WeChat.

## Users

- Individual developers and small engineering teams who run coding agents on a desktop computer and need to step away while work continues.
- The primary job is to inspect progress, continue a conversation, stop a turn, or resolve a clearly identified approval from a phone without exposing the desktop itself.

## Product Purpose

AgentBridge gives one phone control surface for multiple local coding-agent runtimes. Success means a user can scan once, enter a time-limited authenticated session, and see the same structured conversation and execution state as the desktop control surface.

## Positioning

One normalized, capability-aware event stream and control lease spans multiple vendor agents; the phone never becomes the execution environment and never needs provider credentials.

## Operating Context

- A Windows desktop stays online and runs the Bridge plus local Agent child processes.
- A user scans a QR code with WeChat and opens a responsive H5 control surface.
- Projects are selected by server-configured aliases rather than arbitrary phone-supplied paths.
- The user alternates between a desktop browser and a phone, sometimes over an unreliable connection.

## Capabilities and Constraints

- MVP agents: built-in Echo test adapter, real Codex App Server adapter, and real Claude stream-json adapter.
- DeepSeek Harness and ZCode are capability placeholders until supported local integrations are installed and implemented.
- Real-time downlink uses SSE; state-changing commands use idempotent HTTP POST.
- Pairing codes are short-lived and one-time. Session credentials use HttpOnly same-site cookies.
- The MVP does not automate a personal WeChat desktop client and does not include production WeChat Official Account credentials or a cloud Relay.
- Conversation state is synchronized semantically; arbitrary unmodified vendor GUIs are not pixel-mirrored.

## Evidence on Hand

- `docs/architecture/wechat-multi-agent-remote-control.md`
- `docs/research/happy-reference-analysis.md`
- No customer claims, production security audit, logo, or brand assets exist; future surfaces must not fabricate them.

## Product Principles

1. The computer remains the only execution endpoint.
2. Every remote action is scoped, attributable, idempotent, and visible.
3. Show only capabilities the selected adapter actually supports.
4. Reconnection restores state from an ordered event log instead of replaying commands.
5. Safe degradation is explicit: unavailable agents and unsupported approvals are never disguised as working.

## Accessibility & Inclusion

The mobile control surface must support keyboard navigation, visible focus, reduced motion, 44px minimum touch targets, readable Chinese copy, and status communication that does not rely on color alone.

