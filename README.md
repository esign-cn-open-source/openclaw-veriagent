# @esign-cn-open-source/openclaw-veriagent

OpenClaw-side local plugin wrapper for VeriAgent onboarding and certificate tools.

## What it does

- Starts VeriAgent browser-led onboarding
- Generates local CSR materials
- Downloads and imports certificates
- Exposes local `sign` and `verify` commands for agent certificates

## Requirements

- Node.js 18 or later for local plugin runtime
- A reachable VeriAgent backend that exposes the plugin onboarding APIs
- Browser access to the matching VeriAgent portal

## Install

```bash
npx -y --package @esign-cn-open-source/openclaw-veriagent veriagent-openclaw install
```

## Runtime state

- Default runtime state is stored under `~/.openclaw/veriagent/`

