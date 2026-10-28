# Maa Bhagwati General Store — Customer Accounts + Order Tracking + Categories

## What's new
- Customer registration, sign-in and profile editing (name, email, phone, default address)
- My Orders: order history, items, status progress (New → Processing → Shipped → On the way → Delivered), refreshed every 15 seconds while the panel is open
- Admin: order status controls, new category management tab (add and delete empty categories)
- Existing guest orders can be linked from My Orders using their order number and checkout phone number (development convenience, not strong identity verification)
- Product images from HTTPS URLs display in storefront (emoji fallback for products without an image)

## Upgrade an existing installation WITHOUT deleting MySQL data
1. **Back up your database** before making changes:
   `mysqldump -u root -p maa_bhagwati_store > maa_bhagwati_backup.sql`
2. Stop your Node server (Ctrl+C). MySQL should stay running.
3. Copy `public/`, `admin/`, `server/index.js`, and `README_UPGRADE.md` from this package into the original project. **Keep the existing `.env` file**, MySQL database, and existing `node_modules` if present. `server/seed.js` is unchanged.
4. Ensure `.env` still has DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, PORT, ADMIN_PASSWORD, ADMIN_SESSION_SECRET from the previous admin version.
5. In the project folder run `npm install` and then `npm start`.
6. The server automatically adds `customers`, `categories`, and a nullable `orders.customer_id` column to the existing MySQL database. **Do not drop or recreate the database.** Existing orders and products are preserved.
7. Customer site: http://localhost:3000 — click **My Account** to register, **My Orders** to see status, **My Profile** to edit details.
8. Admin: http://localhost:3000/admin — change order status under Customer orders; add categories under Categories, then assign products to them.

## Fresh installation
- Create/import tables with `mysql -u root -p < database/schema.sql`.
- Configure `.env` based on `.env.example`, run `npm install` then `npm start`.

## Notes
- **Previously placed guest orders are not automatically shown** in new accounts. Use the 'Link order' form in My Orders with order ID and checkout phone. For a public production site, replace this with phone OTP or another strong ownership verification method.
- Customer orders placed **after signing in** are automatically linked to that account. Checkout requires sign-in.
- Status is updated by the admin; the customer view polls every 15 seconds while open. It is *not* GPS location tracking or courier integration.
- Login sessions are in server memory, so they are cleared on backend restart. Users must sign in again. For production use persistent session storage, HTTPS, CSRF protections, email/phone verification, stronger rate limiting, and a dedicated restricted MySQL user.
- Product/category changes are saved to the same MySQL database. Existing orders are not deleted.
