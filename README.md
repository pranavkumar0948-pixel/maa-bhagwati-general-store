# Maa Bhagwati General Store — MySQL Edition

Full-stack general-store demo using **HTML, CSS, JavaScript, Node.js, Express, and MySQL**. No SQLite is used.

## Setup (Mac / Windows / Linux)

1. Install Node.js 20+ and MySQL Server 8+. Start the MySQL service.
2. Open a terminal in the project folder and create the database/tables:
   ```bash
   mysql -u root -p < database/schema.sql
   ```
   Alternatively open `database/schema.sql` in MySQL Workbench and execute it.
3. Create your local environment file:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `DB_PASSWORD` to your MySQL password; change `DB_USER` if needed.
4. Install packages and start:
   ```bash
   npm install
   npm start
   ```
5. Open **http://localhost:3000**.

On first launch, the server inserts 28 demo products if the `products` table is empty. Orders, order items and stock changes are saved in MySQL.

## API

- `GET /api/products?q=&category=All`
- `GET /api/categories`
- `POST /api/orders` with `{ "customer":"...", "phone":"...", "address":"...", "items":[{"id":1,"quantity":2}] }`

## Inspect data in MySQL

```sql
USE maa_bhagwati_store;
SELECT * FROM products;
SELECT * FROM orders ORDER BY id DESC;
SELECT * FROM order_items ORDER BY id DESC;
```

## Notes

Prices are sample data and product images are emoji placeholders. Checkout records orders; it does not collect payments or arrange delivery. This is a learning/demo application, not a production-ready commerce system. Add authenticated administration, stronger validation, rate limiting, and deployment security before real use.
