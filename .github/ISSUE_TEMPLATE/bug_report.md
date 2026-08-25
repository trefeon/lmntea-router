---
name: Bug report
about: Report a reproducible bug in lmntea-router
title: "fix: "
labels: [bug]
assignees: []
---

## Description

<!-- Clear, one-sentence summary of the bug -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What should happen -->

## Actual behavior

<!-- What happens instead. Include error envelope: { error: { type, message } } + x-request-id if available -->

## Minimal reproduction

```bash
# curl or app.request snippet that reproduces without real keys
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LMNTEA_API_KEY" \
  -d '{"model":"opencode/x-preview-f-free","messages":[{"role":"user","content":"hi"}],"max_tokens":200000}'
```

```ts
// or Vitest app.request reproduction
import { app } from '@/index.js';
const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' }, body: JSON.stringify({ model: 'opencode/x-preview-f-free', messages: [{ role: 'user', content: 'hi' }] }) });
```

## Environment

- lmntea-router version / commit: <!-- e.g. v0.1.0 or a7c9dae -->
- Runtime: <!-- Node 20.x / Bun 1.2.x -->
- PM: <!-- pnpm 9.x -->
- OS:

## Logs

<!-- Paste relevant server log (redact secrets). Include x-request-id -->

```
```

## Additional context

<!-- Research spec, model id, clamp/transport/streaming area, screenshots if UI -->
