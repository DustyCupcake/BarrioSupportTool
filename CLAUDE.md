# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

**Elsewhere Inventory** is an event-wide equipment management platform for large-scale camp operations. It provides centralized inventory tracking, multi-tier checkout (production → department → group → person), offline-first QR scanning, full audit trails, and volunteer shift management with temporary QR-based sessions.

A "group" is any team/camp/collective a department lends equipment to — it replaces what used to be two parallel entity types (`barrios` and `artists`). Arrival/departure tracking and consumable entitlements are per-group capability flags (`enable_arrival_tracking`, `enable_consumable_entitlements`), not a hardcoded type split.

**Stack:** PHP 7.4+ backend, vanilla ES module JavaScript frontend, MySQL 5.7+, service-worker offline support — no build system.

---

## File Structure

```
elsewhere_inventory/
├── public/                           # Document root
│   ├── index.html                    # Main staff app (checkout, checkin, inventory, history, orders)
│   ├── login.html / register.html / shift.html   # Auth pages
│   ├── water.html / voucher.html / item.html      # Special-purpose public pages
│   ├── admin/index.html              # Admin panel
│   ├── sw.js                         # Service worker (offline queue, app shell caching)
│   ├── manifest.json                 # PWA manifest
│   ├── api/
│   │   ├── index.php                 # API router (route table → dispatches to handlers)
│   │   ├── auth.php                  # Auth middleware, permission system, session management
│   │   ├── lib/db.php                # PDO singleton, .env-based connection
│   │   ├── lib/response.php          # json_ok(), json_error(), body(), require_method()
│   │   ├── lib/holder.php            # set_item_holder(), item_holder_label() — the holder model helpers
│   │   ├── lib/group_location.php    # get_group_location() — GPS fallback from a group's storage location
│   │   └── routes/
│   │       ├── auth.php              # Login, logout, register, language, invite/shift tokens
│   │       ├── transactions.php      # Checkout, checkin, person-checkout, label, use/activate
│   │       ├── items.php             # Item lookup, inventory list
│   │       ├── persons.php           # Person info and search
│   │       ├── departments.php       # List departments
│   │       ├── groups.php            # List groups, arrival/departure, consumable distribution
│   │       ├── orders.php            # Dept equipment orders
│   │       ├── consumables.php       # Consumable types, entitlements, group CSV import
│   │       ├── history.php           # Transaction log
│   │       ├── sync.php              # Offline queue sync endpoint
│   │       ├── voucher.php           # Public voucher status check
│   │       ├── item_public.php       # Public item info page
│   │       └── admin/                # Admin-only endpoints
│   │           ├── departments.php   # CRUD, dept role assignment
│   │           ├── groups.php        # CRUD, CSV import (merges what used to be admin/barrios.php + admin/artists.php)
│   │           ├── equipment.php     # Equipment types/items, borrowable rules
│   │           ├── users.php         # User CRUD, password reset, QR sheet export
│   │           ├── invite.php        # Invite token CRUD
│   │           ├── shifts.php        # Shift CRUD, token generation, QR sheet
│   │           ├── qr_sheet.php      # Bulk equipment label QR sheet export
│   │           └── group_qr.php      # Group QR code batch export
│   └── assets/
│       ├── css/main.css / app.css / admin.css
│       ├── js/
│       │   ├── app.js                # Entry point: tab routing, session check, toast notifications
│       │   ├── api.js                # Fetch wrapper with CSRF header, offline queue integration
│       │   ├── offline.js            # LocalStorage queue for checkout/checkin when offline
│       │   ├── i18n.js               # Internationalization (EN/ES/FR), locale switching
│       │   ├── scanner.js            # BarcodeDetector API + jsQR fallback
│       │   ├── scan-overlay.js       # Full-screen confirmation overlay for scans
│       │   ├── checkout.js           # 3-step flow: entity select → scan → confirm
│       │   ├── checkin.js            # Scan → confirm → return/transfer
│       │   ├── groups.js             # Group management UI (arrival, departure, entitlements)
│       │   ├── inventory.js          # Equipment list with status filters
│       │   ├── history.js            # Transaction log
│       │   ├── order-form.js         # Dept equipment order submission
│       │   ├── validate.js           # Voucher validation mode toggle
│       │   ├── activate.js           # Dual-QR voucher activation
│       │   ├── water.js / voucher.js / item-public.js   # Special-purpose pages
│       │   └── admin/
│       │       ├── admin.js          # Admin sidebar nav router
│       │       ├── equipment.js / users.js / groups.js / consumables.js
│       └── vendor/
│           ├── jsqr.min.js           # QR decoder fallback
│           └── phpqrcode/            # QR generation (label sheets)
├── schema.sql                        # Complete DB schema for fresh installs
├── migrate_*.sql                     # Incremental migrations for upgrades
├── setup.php                         # One-time first-admin creation (delete after use)
├── .env / .env.example               # Runtime config (DB credentials, SETUP_TOKEN, APP_TIMEZONE)
└── .htaccess                         # Root: denies .env, .sql, .md, .json access
```

---

## Backend Architecture

### API Router (`public/api/index.php`)

Simple route table: `[METHOD, PATH, FILE, FUNCTION]` tuples iterated in order. Supports `:id` segments (e.g. `/departments/:id` → named capture placed into `$_GET['id']`). All responses are JSON. Global exception handler returns `{error: "message"}` with HTTP 500.

URL rewriting in `public/.htaccess`:
```
RewriteRule ^api/(.*)$ api/index.php?path=$1 [QSA,L]
```

### Authentication & Permissions (`public/api/auth.php`)

**Sessions:** PHP sessions with 3-day lifetime, HTTP-only, SameSite=Strict, stored in `/sessions`.

**Two session types:**
- Standard login (username + bcrypt password)
- Shift QR login — volunteer scans a printed QR, enters name, gets a temporary session with the shift's exact permission set. No password.

**Named-permission model:** Permissions are computed at login as a flat array and stored in session.
- Base role → default permission set
- `user_dept_roles` memberships + dept `manages_groups` flag → additional perms (`view_groups`, `manage_groups`, `sub_checkout`, `sub_checkin`, `label_equipment`)
- `user_permissions` overrides (granted/denied) applied last

A `group_roles` table (per-group membership, mirroring `user_dept_roles`) lets a user get access to one specific group without being department staff. It's wired into `compute_permissions()` (`GROUP_ROLE_PERMISSIONS` in `auth.php`), but currently only grants `view_groups` — the permission model has no per-group scoping for mutating operations (sub_checkout/sub_checkin/etc. are still dept-scoped only, via `dept_ids`), so broader group-scoped write access is a deliberate follow-up, not built yet.

**Base roles and default permissions:**
- `production_admin` — everything
- `production_staff` — checkout/checkin, validate vouchers, view inventory
- `dept_admin` — sub-checkout/sub-checkin, manage own department, create invites
- `dept_staff` — sub-checkout/sub-checkin (if dept is sub-lending), view dept inventory, submit orders
- Legacy aliases: `admin` → `production_admin`, `staff` → `production_staff`, `validator` → `dept_staff`

**Key permission strings:** `checkout_equipment`, `checkin_equipment`, `sub_checkout`, `sub_checkin`, `validate_vouchers`, `view_inventory`, `view_dept_inventory`, `view_groups`, `manage_equipment`, `manage_consumables`, `manage_users`, `manage_departments`, `manage_groups`, `manage_shifts`, `create_invites`, `submit_orders`, `label_equipment`, `person_checkout`

**CSRF:** `X-CSRF-Token` header required for all POST/PUT/DELETE. Token returned by `GET /auth/me` and `GET /auth/csrf`, verified by `verify_csrf()` in auth.php.

### Database (`public/api/lib/db.php`)

PDO singleton via `db()`. Config from `.env` (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`). utf8mb4, exceptions enabled, associative fetch, prepared statements without emulation.

**PDO execute() returns bool, not $this.** Never chain `->execute()->fetch()`. Always split onto separate lines:
```php
// WRONG — execute() returns bool, fetch() will throw "call to member function on bool"
$row = db()->prepare('SELECT ...')->execute([$id])->fetch();

// CORRECT
$stmt = db()->prepare('SELECT ...');
$stmt->execute([$id]);
$row = $stmt->fetch();
```

### Transaction Model

All checkout/checkin operations use `SELECT ... FOR UPDATE` row locking and are wrapped in a database transaction. Every state change writes an immutable row to `transactions`.

**Holder model:** `equipment_items` tracks who currently has an item via a single `holder_type ENUM('department','group','person') NULL` + `holder_id` pair, not a set of type-specific nullable columns. `holder_type IS NULL` means the item is available in the production pool. `owning_dept_id` is a separate field — the department whose pool the item belongs to, which persists through sub-lending independent of who currently holds it. A DB trigger enforces `holder_type IS NULL ⟺ status IN ('available','retired')` and `holder_type IS NULL ⟺ holder_id IS NULL` — any write that violates this raises a SQL error, so any handler that changes `status` must also resolve `holder_type`/`holder_id` consistently (use `set_item_holder()` from `lib/holder.php`). `transactions` mirrors the same `holder_type`/`holder_id` shape (`dept_id` stays as the owning-department context).

**Checkout tiers:**
- `POST /checkout` (production → dept): sets `owning_dept_id`, `holder_type='department'`
- `POST /sub-checkout` (dept → group): sets `holder_type='group'`, keeps `owning_dept_id`
- `POST /person-checkout` / `POST /sub-person-checkout`: sets `holder_type='person'`
- `POST /checkin`: auto-detects holder tier from `holder_type`, returns item to the appropriate level (dept-held state if there's an owning department, otherwise fully available)

---

## Frontend Architecture

### Module System

No build step. All JS is vanilla ES modules loaded by the browser. Cache-busting via `?v=X.X.X` version strings on imports.

**`app.js`** (entry point): checks session via `GET /auth/me`, sets up tab routing, registers service worker, handles toast notifications.

**`api.js`**: `api(method, path, body)` wrapper with automatic CSRF header injection. Redirects to login on 401. Falls back to offline queue (localStorage) when network is unavailable.

**`offline.js`**: LocalStorage queue. Queued transactions sync via `POST /sync/offline-queue` when online. Service worker caches the app shell but does not manage the queue.

**`i18n.js`**: Translation strings keyed by namespace. Applies to DOM via `data-i18n` attributes. Language persisted server-side via `POST /auth/language`.

### Admin Panel

`admin/admin.js` routes sidebar nav clicks to section modules (`equipment.js`, `users.js`, `groups.js`, `consumables.js`). Sections load/unload themselves as the active section changes.

---

## Setup & Deployment

### Fresh Installation

```bash
# 1. Configure .env
cp .env.example .env && nano .env   # set DB_HOST, DB_NAME, DB_USER, DB_PASS, SETUP_TOKEN, APP_TIMEZONE

# 2. Import schema
mysql -u user -p else_inventory < schema.sql

# 3. Serve with document root pointing to public/
# 4. Create first admin
#    Visit https://yoursite/setup.php?token=<SETUP_TOKEN>  — DELETE setup.php after use
```

### Upgrading Existing Installation

Apply migrations in this order (dependencies must be respected):

```bash
mysql -u user -p db < migrate_user_language.sql
mysql -u user -p db < migrate_barrio_status.sql
mysql -u user -p db < migrate_consumables.sql
mysql -u user -p db < migrate_secure_qr.sql
mysql -u user -p db < migrate_activate.sql
mysql -u user -p db < migrate_fill_confirm.sql
mysql -u user -p db < migrate_overhaul.sql        # depends on user_language being applied first
mysql -u user -p db < migrate_person_checkout.sql # depends on overhaul
mysql -u user -p db < migrate_borrow_restrictions.sql  # depends on person_checkout
mysql -u user -p db < migrate_groups_holder_model.sql   # merges barrios+artists into groups; replaces the
                                                          # four-nullable-holder-column model on equipment_items/
                                                          # transactions with holder_type/holder_id. NOT staged for
                                                          # zero-downtime — take a full backup first, see the file's
                                                          # header comment.
mysql -u user -p db < migrate_phase3_identity.sql        # adds groups.enable_self_service_shift; provisions standing
                                                          # shifts for existing groups so barrio self-identify keeps
                                                          # working. Depends on migrate_groups_holder_model.sql.
```

### Adding an Endpoint

1. Add `[METHOD, PATH, 'routes/file.php', 'function_name']` to the route table in `index.php`
2. Implement the handler function in the routes file
3. Call `require_permission('name')` and `verify_csrf()` (for mutating requests) at the top
4. Use `body()` to parse request body, prepared statements for all queries
5. Return `json_ok($data)` or `json_error($message, $status)`

### Adding a Frontend Feature

1. Create a module in `assets/js/` exporting `init()` (and optionally `destroy()`)
2. Import via `app.js` or `admin/admin.js`
3. Use `api.js` for all backend calls
4. Add i18n keys to `i18n.js` for all user-visible strings
5. Bump the `?v=` cache-bust version on any changed imports

### Adding Database Fields

1. Update `schema.sql` (fresh installs)
2. Create a `migrate_FEATURENAME.sql` file (existing installs)
3. Update relevant route handlers

---

## Key Workflows

### Equipment Checkout

1. User selects entity type (dept/group/person) based on role
2. Scans items — QR codes validated via `GET /items/lookup`
3. Confirms → `POST /checkout` or `POST /sub-checkout` with item QR array
4. If offline, request queued to localStorage and synced later via `POST /sync/offline-queue`

### Shift QR Volunteer Session

1. Admin creates shift with time window and permissions; generates token QRs
2. Volunteer scans printed QR → navigated to `/shift.html`
3. Enters name → `POST /auth/shift-login` creates temporary session
4. Session inherits exactly the shift's permissions; expires at `active_until`

### User Invitation & Registration

1. Admin creates invite: `POST /admin/invite-tokens` (role, optional dept, expiry)
2. Invite link: `/?invite_token=<token>` — `GET /auth/invite-info` validates (public)
3. Registration form pre-populated with role/dept; `POST /auth/register` creates account (single-use)

### QR Sheet Exports

- Equipment labels: `GET /admin/items/qr-sheet`
- Shift tokens: `GET /admin/shifts/qr-sheet`
- User personal QRs: `GET /admin/users/qr-sheet`
- Group QRs: `GET /admin/group-qr`
