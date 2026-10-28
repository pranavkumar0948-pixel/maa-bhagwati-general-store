# Admin Dashboard Upgrade (MySQL)

This ZIP contains the full store plus an admin dashboard. **Keep your existing database**. Do not drop or recreate it; the existing schema already supports these features.

## Upgrade an existing installation

1. Stop the running Node server with Ctrl+C. MySQL can stay running.
2. Back up your current project folder.
3. Copy these files from this ZIP into the matching paths in your existing project: `server/index.js`, `admin/index.html`, `admin/admin.css`, `admin/admin.js`. The other original files remain unchanged.
4. In the existing `.env` file, **keep your existing DB_* credentials** and add:

```env
ADMIN_PASSWORD=choose_a_unique_password_at_least_12_chars
ADMIN_SESSION_SECRET=put_a_random_secret_of_at_least_32_chars_here
```

Generate a strong secret with `openssl rand -hex 32`. Do not put credentials in Git.
5. Run `npm install` (if necessary), then `npm start`.
6. Visit `http://localhost:3000/admin`. The storefront remains at `http://localhost:3000/`.

## Admin functions

- Password-protected admin sign-in (server-side session with signed HttpOnly cookie).
- Dashboard counts, non-cancelled order totals, low-stock alert.
- Add/edit/delete products, categories, prices, descriptions, stock, and HTTPS product image URLs.
- View customer orders and their line items; update order statuses.
- Existing products and orders remain in MySQL. Deletion of a product referenced by an order is blocked by the database; set its stock to zero instead.

## Important limitations

This is a **local development** admin dashboard, not a production-hardened ecommerce admin. It uses one admin password, in-memory sessions (lost on restart), basic per-process login throttling, and an Origin check. For internet deployment add HTTPS, persistent sessions, dedicated DB user, comprehensive CSRF protection, auditing, robust authentication/rate limiting, and stronger order management. Cancelling an order changes status but does not automatically restock products. Product images are HTTPS URLs rather than uploaded files.
