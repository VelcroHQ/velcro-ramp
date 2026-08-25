# Agent Guidance — Velcro Ramp

This project uses the **Claude Code Skills** library (`claude-skills/`) as the
primary knowledge base — the agent's "brain" — for all frontend and backend work.
The library is cloned at `c:\Users\HomePC\Downloads\velcro-ramp\claude-skills\`.

**Default rule:** For every prompt, every task, and every file change, apply the
relevant skill packages below automatically. Do not fall back to generic advice
when a skill covers the topic. If a task is outside the quick-reference rules,
read the referenced `SKILL.md` file before proceeding.

## Default Operating Mode

1. Identify which skill(s) apply to the user's request.
2. Read the relevant `SKILL.md` (and any referenced `references/*.md`) before
   planning or coding.
3. Apply the skill's workflows, decision engines, and success criteria.
4. If multiple skills apply, compose them; do not ignore one discipline for
   another (e.g., security and frontend both apply to a login form).
5. When in doubt, route through the lookup map at the bottom of this file.

---

## Project Stack

- **Backend:** Plain PHP 8.1+ + PDO MySQL (no framework). Entry point is
  `php-backend/index.php`. Static assets are served from `public/`.
- **Frontend:** Vanilla HTML/CSS/JS (`public/index.html`, `public/style.css`).
- **Infra:** Shared-hosting-friendly. Web server document root points to
  `public/`; API requests are routed through `php-backend/index.php` via
  rewrite rules (see `php-backend/.htaccess`).
- **External APIs:** Switch (`https://api.onswitch.xyz`) and PAJ
  (`https://api.paj.cash`) are called directly over HTTP.
- **Legacy:** The Node.js + Express + MongoDB backend (`server.js`, `paj.js`,
  `package.json`) and the old VPS deployment scripts have been removed.

---

## Backend Discipline (`engineering-team/skills/senior-backend/`)

Reference: `engineering-team/skills/senior-backend/SKILL.md` and
`engineering-team/skills/senior-backend/references/backend_security_practices.md`

### Security hardening (always-on)

- Secrets must come from `php-backend/.env`. No hardcoded keys, passwords, or
  fallback values for sensitive data.
- Set security headers in PHP (`jsonResponse()`) and in the web server config.
- Rate-limit all `/api/*` routes, especially auth, withdrawal, OTP, and webhook
  endpoints. Use separate stricter limits for sensitive operations.
- Validate every request body, query, and param explicitly.
- Return generic error messages in production; log full errors server-side with a
  request ID.
- Prevent SQL injection: use PDO prepared statements everywhere.
- Verify ownership on every resource endpoint (broken access control / OWASP A01).

### API design

- Keep the existing route contract stable (`/api/*`, `/webhook/*`).
- Return consistent envelope shapes: `{ success: bool, message?: string, data?: mixed }`
  or `{ error: string }` for failures.
- Paginate list endpoints; default `limit` should be small (e.g., 20).

### Database / MySQL

- Index fields used in filters, sorts, and unique constraints.
- Avoid N+1 queries; join or aggregate deliberately.
- Run `EXPLAIN` on slow queries before adding indexes.
- Keep migrations idempotent where possible (`sql/schema.sql`).

### Webhooks

- Verify webhook signatures (`PAJ_WEBHOOK_SECRET`, `SWITCH_WEBHOOK_SECRET`)
  before processing. Refuse webhooks if the secret is not configured.
- Return 200 quickly and process work asynchronously when possible.
- Idempotency: guard against duplicate events using `reference` as a unique key.

---

## Frontend Discipline (`engineering-team/skills/senior-frontend/`)

Reference: `engineering-team/skills/senior-frontend/SKILL.md`

### Vanilla HTML/CSS/JS rules

- Prefer semantic HTML (`<button>`, `<nav>`, `<main>`, `<section>`).
- All interactive elements must be keyboard focusable and have visible focus
  states.
- Add `aria-label` to icon-only buttons and complex widgets.
- Maintain 4.5:1 contrast for normal text.
- Keep the inline `<style>` and `<script>` blocks maintainable; extract repeated
  patterns into `style.css` or external modules.
- Avoid blocking the initial render with render-critical third-party scripts.
  Load non-essential scripts with `defer` or `async`.

### Performance

- Set explicit `width`/`height` on images or use CSS aspect-ratio to reduce CLS.
- Minimize render-blocking resources; preconnect to required origins.
- Keep the main bundle (this page is all inline) lightweight on mobile networks.

### If later migrating to React/Next.js

- Read the full senior-frontend SKILL.md first.
- Use Server Components by default; add `'use client'` only for interactivity,
  state, effects, or browser APIs.
- Set a per-route JS bundle budget and Core Web Vitals targets before scaffolds.

---

## General Engineering Rules

- Make minimal changes to achieve the goal. Preserve existing logic unless
  security or correctness demands a fix.
- Follow the existing code style in `php-backend/` and `public/`.
- Test changes locally (`php -S localhost:8002 -t php-backend php-backend/index.php`
  or the user's chosen port) when safe.
- Do not commit git mutations unless explicitly asked.
- Before large refactors, run the relevant skill scripts if applicable
  (e.g., decision engines in `engineering-team/skills/*/scripts/`).

---

## Skill Lookup Map

| Task | Read first |
|------|-----------|
| Backend API design / security / DB | `engineering-team/skills/senior-backend/SKILL.md` |
| Frontend HTML/CSS/JS, a11y, perf | `engineering-team/skills/senior-frontend/SKILL.md` |
| Fullstack scaffold or architecture | `engineering-team/skills/senior-fullstack/SKILL.md` |
| Code review | `engineering-team/skills/code-reviewer/SKILL.md` |
| Security audit / pen-test | `engineering-team/skills/senior-security/SKILL.md` |
| Accessibility audit | `engineering-team/skills/a11y-audit/SKILL.md` |
| DevOps / CI/CD | `engineering-team/skills/senior-devops/SKILL.md` |
| Performance profiling | `engineering/skills/performance-profiler/SKILL.md` |

---

## How to Use the Cloned Library

The full library is available at `claude-skills/`. When a task maps to a skill,
read its `SKILL.md` and any referenced `references/*.md` files. Do not try to
memorize the entire library; reference it on demand.
