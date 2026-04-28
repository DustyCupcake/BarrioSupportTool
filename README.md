# Barrio Support

An equipment checkout and asset tracking system built for camp operations. Staff can check equipment in and out across multiple barrios (theme camps), track consumables like water vouchers and ice tokens, and maintain a full audit trail — all with offline-first support via QR code scanning.

## Features

**Staff**
- QR-based equipment checkout (3-step flow: select barrio → scan items → confirm)
- Equipment check-in
- Barrio arrival / departure tracking
- Real-time inventory view (available, checked out, current holder)
- Full transaction history
- Offline queuing — transactions save locally and sync automatically on reconnect
- Consumables distribution (water, ice, or custom types)

**Admin**
- User management (create staff accounts, assign roles, reset passwords)
- Equipment catalog (types + individual items with QR codes)
- Bulk QR sheet generation for printing equipment labels
- Barrio configuration (entitlements, equipment orders)
- Consumable types and purchase tracking
- CSV bulk import for barrio setup

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JavaScript (ES modules), HTML5, CSS3 |
| Backend | PHP 7.4+ with PDO |
| Database | MySQL 5.7+ or MariaDB 10.3+ |
| Offline | Service Worker + IndexedDB |
| QR Scanning | Native `BarcodeDetector` API with jsQR fallback |
| Hosting | Shared hosting compatible (cPanel etc.) |

No build system required — no npm, no bundler, no framework.

## Project Structure

```
barrio_support/
├── public/                  # Web root (set this as document root)
│   ├── index.html           # Staff app
│   ├── login.html
│   ├── manifest.json        # PWA manifest
│   ├── sw.js                # Service worker
│   ├── admin/
│   │   └── index.html       # Admin panel
│   ├── api/
│   │   ├── index.php        # API router
│   │   ├── auth.php         # Session middleware
│   │   ├── lib/             # DB connection, response helpers
│   │   └── routes/          # Endpoint handlers
│   └── assets/
│       ├── css/
│       ├── js/
│       └── vendor/          # jsqr, phpqrcode
├── schema.sql               # Full database schema
├── migrate_*.sql            # Feature migrations
├── setup.php                # First-admin creation (delete after use)
├── .env.example
└── .htaccess
```

## Setup

### 1. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```
DB_HOST=localhost
DB_NAME=barrio_support
DB_USER=your_db_user
DB_PASS=your_db_password
SETUP_TOKEN=<long_random_string>
```

### 2. Import the database schema

```bash
mysql -u your_db_user -p barrio_support < schema.sql
```

### 3. Set the document root

Point your web server's document root to the `/public` directory. The `.htaccess` file handles URL rewriting for the API router.

### 4. Create the first admin account

Visit `https://yourdomain.com/setup.php?token=<your_SETUP_TOKEN>` and follow the prompts. Delete `setup.php` immediately after creating the account.

### 5. Log in

Go to `/login.html`. Staff use the main app at `/`, admins access the admin panel at `/admin/`.

## API Overview

All endpoints are under `/api/`. Requests require an active session cookie and a `X-CSRF-Token` header (obtained from `GET /api/auth/me`).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/auth/login` | Authenticate |
| `GET` | `/auth/me` | Current user + CSRF token |
| `GET` | `/items/lookup?qr=<code>` | Look up item by QR code |
| `GET` | `/inventory` | All equipment with status |
| `POST` | `/checkout` | Check out items to a barrio |
| `POST` | `/checkin` | Return items to inventory |
| `GET` | `/history` | Transaction history |
| `GET` | `/barrios` | List all barrios |
| `POST` | `/barrio-arrival` | Mark barrio as arrived |
| `POST` | `/barrio-departure` | Mark barrio as departed |
| `POST` | `/barrio-distribute` | Distribute consumables |
| `POST` | `/sync/offline-queue` | Sync offline transaction queue |

Admin routes follow the same pattern under `/api/admin/*` and require the `admin` role.

## Offline Support

The app registers a service worker that caches the app shell for fast loads and offline access. When a checkout or check-in is attempted without a network connection, the transaction is saved to an IndexedDB queue and synced automatically when connectivity is restored.

## Security

- Passwords hashed with bcrypt
- CSRF protection on all state-changing requests
- HTTP-only, same-site session cookies (3-day expiry)
- Row-level locking (`SELECT ... FOR UPDATE`) prevents concurrent double-checkouts
- All checkout/check-in operations run inside database transactions
- Admin routes enforce role checks server-side

## Requirements

- PHP 7.4+
- MySQL 5.7+ or MariaDB 10.3+
- A web server with `.htaccess` / `mod_rewrite` support
- HTTPS recommended (required for camera access on most browsers)
