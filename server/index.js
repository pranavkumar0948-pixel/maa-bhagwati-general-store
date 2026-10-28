require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const seed = require('./seed');
const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname, '../admin/index.html')));
app.use('/admin-assets', express.static(path.join(__dirname, '../admin')));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'maa_bhagwati_store',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true
});

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(170) NOT NULL,
    phone VARCHAR(18) NOT NULL, address VARCHAR(500) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE
  ) ENGINE=InnoDB`);
  const [cols]=await pool.query("SHOW COLUMNS FROM orders LIKE 'customer_id'");
  if(!cols.length)await pool.query('ALTER TABLE orders ADD COLUMN customer_id INT NULL, ADD INDEX idx_orders_customer (customer_id), ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)');
  await pool.query('INSERT IGNORE INTO categories(name) SELECT DISTINCT category FROM products');
  for(const name of ['Groceries','Dairy & Eggs','Fruits & Vegetables','Snacks & Drinks','Personal Care','Home Care'])await pool.execute('INSERT IGNORE INTO categories(name) VALUES(?)',[name]);
}

async function initialize() {
  await migrate();
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM products');
  if (rows[0].count === 0) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of seed) {
        await conn.execute('INSERT INTO products(name,category,description,price,old_price,emoji) VALUES(?,?,?,?,?,?)', item);
      }
      await conn.commit();
      console.log(`Seeded ${seed.length} sample products`);
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }
}

// Customer accounts: scrypt password hashes and HttpOnly signed sessions.
const customerSessions = new Map();
const customerAttempts = new Map();
function customerSession(req) {
  const raw = cookies(req).mb_customer || '';
  const [token, signature] = raw.split('.');
  if (!token || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sign(token)), Buffer.from(signature))) return null;
  const session = customerSessions.get(token);
  if (!session || session.expires < Date.now()) { customerSessions.delete(token); return null; }
  return session;
}
function customerAuth(req,res,next) {
  const session=customerSession(req);
  if (!session) return res.status(401).json({error:'Please sign in to your account'});
  req.customerId=session.id; next();
}
function customerCookie(res,token,maxAge=604800) {
  res.setHeader('Set-Cookie',`mb_customer=${token ? token+'.'+sign(token) : ''}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`);
}
function customerLogin(res,id) {
  const token=crypto.randomBytes(32).toString('hex');
  customerSessions.set(token,{id,expires:Date.now()+7*86400000});
  customerCookie(res,token);
}
function validEmail(email) {return typeof email==='string' && email.length<=190 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);}
app.post('/api/account/register',async(req,res)=>{
  const {name,email,password,phone,address}=req.body||{};
  if(typeof name!=='string'||name.trim().length<2||name.length>120||!validEmail(email)||typeof password!=='string'||password.length<10||password.length>128||typeof phone!=='string'||!/^[0-9+()\s-]{8,18}$/.test(phone)||typeof address!=='string'||address.length>500)
    return res.status(400).json({error:'Enter a name, valid email, password (10+ characters), phone and optional address.'});
  try {
    const salt=crypto.randomBytes(16).toString('hex');
    const hash=crypto.scryptSync(password,salt,64).toString('hex');
    const [r]=await pool.execute('INSERT INTO customers(name,email,password_hash,phone,address) VALUES(?,?,?,?,?)',[name.trim(),email.toLowerCase().trim(),salt+':'+hash,phone.trim(),address.trim()]);
    customerLogin(res,r.insertId);res.status(201).json({ok:true});
  }catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'Email already registered'});console.error(e);res.status(500).json({error:'Registration failed'});}
});
app.post('/api/account/login',async(req,res)=>{
  const {email,password}=req.body||{};
  const key=req.ip; const attempt=customerAttempts.get(key)||{count:0,until:0};
  if(attempt.until>Date.now())return res.status(429).json({error:'Too many attempts. Try again in 15 minutes.'});
  try {
    const [rows]=await pool.execute('SELECT id,password_hash FROM customers WHERE email=?',[String(email||'').toLowerCase().trim().slice(0,190)]);
    const stored=rows[0]?.password_hash||'';const [salt,expected]=stored.split(':');
    const candidate=crypto.scryptSync(String(password||'').slice(0,128),/^[a-f0-9]{32}$/.test(salt||'')?salt:'00000000000000000000000000000000',64);
    const ok=!!rows.length&&/^[a-f0-9]{128}$/.test(expected||'')&&crypto.timingSafeEqual(candidate,Buffer.from(expected,'hex'));
    if(!ok){attempt.count++;attempt.until=attempt.count>=5?Date.now()+15*60000:0;customerAttempts.set(key,attempt);return res.status(401).json({error:'Invalid email or password'});}
    customerAttempts.delete(key);customerLogin(res,rows[0].id);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Sign in failed'});}
});
app.post('/api/account/logout',customerAuth,(req,res)=>{
  const token=(cookies(req).mb_customer||'').split('.')[0];customerSessions.delete(token);customerCookie(res,'',0);res.json({ok:true});
});
app.get('/api/account/me',customerAuth,async(req,res)=>{
  try{const [rows]=await pool.execute('SELECT id,name,email,phone,address FROM customers WHERE id=?',[req.customerId]);res.json(rows[0]||null)}catch(e){console.error(e);res.status(500).json({error:'Profile unavailable'})}
});
app.put('/api/account/me',customerAuth,async(req,res)=>{
  const {name,phone,address}=req.body||{};
  if(typeof name!=='string'||name.trim().length<2||name.length>120||typeof phone!=='string'||!/^[0-9+()\s-]{8,18}$/.test(phone)||typeof address!=='string'||address.length>500)return res.status(400).json({error:'Invalid profile details'});
  try{await pool.execute('UPDATE customers SET name=?,phone=?,address=? WHERE id=?',[name.trim(),phone.trim(),address.trim(),req.customerId]);res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Could not save profile'})}
});
app.get('/api/account/orders',customerAuth,async(req,res)=>{
  try{
    const [orders]=await pool.execute('SELECT id,total,status,created_at,address FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100',[req.customerId]);
    if(!orders.length)return res.json([]);
    const [items]=await pool.query('SELECT oi.order_id,oi.quantity,oi.unit_price,p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id IN ('+orders.map(()=>'?').join(',')+')',orders.map(o=>o.id));
    res.json(orders.map(o=>({...o,items:items.filter(i=>i.order_id===o.id)})));
  }catch(e){console.error(e);res.status(500).json({error:'Could not load orders'})}
});
// Existing guest orders can be linked after verifying their order number and phone.
const claimAttempts=new Map();
app.post('/api/account/claim-order',customerAuth,async(req,res)=>{
  const id=Number(req.body?.orderId),phone=String(req.body?.phone||'').trim();
  const key=req.customerId;const a=claimAttempts.get(key)||{count:0,until:0};
  if(a.until>Date.now())return res.status(429).json({error:'Try again later'});
  if(!Number.isInteger(id)||id<1||!/^\d{10}$/.test(phone.replace(/\D/g,'')))return res.status(400).json({error:'Enter order number and 10-digit phone'});
  try{
    const [r]=await pool.execute('UPDATE orders SET customer_id=? WHERE id=? AND customer_id IS NULL AND phone=?',[req.customerId,id,phone]);
    if(!r.affectedRows){a.count++;a.until=a.count>=5?Date.now()+15*60000:0;claimAttempts.set(key,a);return res.status(404).json({error:'Order not found or already linked'});}
    claimAttempts.delete(key);res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Could not link order'})}
});

app.get('/api/products', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const category = typeof req.query.category === 'string' ? req.query.category : 'All';
    const [rows] = await pool.execute(
      "SELECT * FROM products WHERE (name LIKE ? OR description LIKE ?) AND (?='All' OR category=?) ORDER BY id",
      [`%${q}%`, `%${q}%`, category, category]
    );
    res.json(rows);
  } catch (error) { console.error(error); res.status(500).json({ error: 'Failed to fetch products' }); }
});

app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT c.name AS category, COUNT(p.id) AS count FROM categories c LEFT JOIN products p ON p.category=c.name GROUP BY c.id,c.name ORDER BY c.name');
    res.json(rows);
  } catch (error) { console.error(error); res.status(500).json({ error: 'Failed to fetch categories' }); }
});

app.post('/api/orders', async (req, res) => {
  const { customer, phone, address, items } = req.body || {};
  if (typeof customer !== 'string' || customer.trim().length < 2 ||
      typeof phone !== 'string' || !/^[0-9+()\s-]{8,18}$/.test(phone) ||
      typeof address !== 'string' || address.trim().length < 8 ||
      !Array.isArray(items) || !items.length || items.length > 50 ||
      items.some(item => !Number.isInteger(item.id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) ||
      new Set(items.map(item => item.id)).size !== items.length) {
    return res.status(400).json({ error: 'Please enter valid delivery details and cart items.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let total = 0;
    const lines = [];
    // Lock rows until the transaction commits to prevent overselling.
    for (const item of [...items].sort((a, b) => a.id - b.id)) {
      const [rows] = await conn.execute('SELECT id, name, price, stock FROM products WHERE id = ? FOR UPDATE', [item.id]);
      const product = rows[0];
      if (!product || product.stock < item.quantity) {
        const err = new Error(`${product?.name || 'Product'} is unavailable in the requested quantity`);
        err.status = 400;
        throw err;
      }
      total += Number(product.price) * item.quantity;
      lines.push({ product, quantity: item.quantity });
    }
    const [result] = await conn.execute(
      'INSERT INTO orders(customer, phone, address, total, customer_id) VALUES(?,?,?,?,?)',
      [customer.trim().slice(0,120), phone.trim(), address.trim().slice(0,500), total, customerSession(req)?.id || null]
    );
    for (const { product, quantity } of lines) {
      await conn.execute('INSERT INTO order_items(order_id, product_id, quantity, unit_price) VALUES(?,?,?,?)',
        [result.insertId, product.id, quantity, product.price]);
      await conn.execute('UPDATE products SET stock = stock - ? WHERE id = ?', [quantity, product.id]);
    }
    await conn.commit();
    res.status(201).json({ orderId: result.insertId, total });
  } catch (error) {
    await conn.rollback();
    console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to place order' });
  } finally { conn.release(); }
});


// Local-development admin authentication: signed, HttpOnly session cookie.
// Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in .env before starting.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
if (ADMIN_PASSWORD.length < 12 || SESSION_SECRET.length < 32) {
  console.error('Set ADMIN_PASSWORD (12+ chars) and ADMIN_SESSION_SECRET (32+ chars) in .env');
  process.exit(1);
}
const adminSalt = crypto.randomBytes(16);
const adminHash = crypto.scryptSync(ADMIN_PASSWORD, adminSalt, 64);
const sessions = new Map();
const attempts = new Map();
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s).slice(0,2)).filter(x => x.length === 2));
}
function sign(token) { return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex'); }
function getSession(req) {
  const raw = cookies(req).mb_admin || '';
  const [token, signature] = raw.split('.');
  if (!token || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sign(token)), Buffer.from(signature))) return null;
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return null; }
  return token;
}
function auth(req,res,next) {
  if (!getSession(req)) return res.status(401).json({error:'Admin login required'});
  next();
}
function checkOrigin(req,res,next) {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.headers.host}`) return res.status(403).json({error:'Invalid request origin'});
  next();
}
app.use('/api/admin', checkOrigin);
app.post('/api/admin/login', (req,res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || {count:0, until:0};
  if (a.until > Date.now()) return res.status(429).json({error:'Too many attempts. Try again later.'});
  const candidate = typeof req.body?.password === 'string' ? req.body.password : '';
  const candidateHash = crypto.scryptSync(candidate.slice(0,256), adminSalt, 64);
  if (!crypto.timingSafeEqual(adminHash, candidateHash)) {
    a.count++; a.until = a.count >= 5 ? Date.now() + 15*60*1000 : 0;
    attempts.set(ip,a);
    return res.status(401).json({error:'Incorrect password'});
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token,Date.now()+8*60*60*1000);
  res.setHeader('Set-Cookie', `mb_admin=${token}.${sign(token)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ok:true});
});
app.get('/api/admin/me',auth,(req,res)=>res.json({authenticated:true}));
app.post('/api/admin/logout',auth,(req,res)=>{
  sessions.delete(getSession(req));
  res.setHeader('Set-Cookie','mb_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0');
  res.json({ok:true});
});
const fields = ['name','category','description','price','old_price','emoji','image','stock'];
function parseProduct(body) {
  if (!body || typeof body !== 'object') return null;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '🛍️';
  const image = typeof body.image === 'string' ? body.image.trim() : '';
  const price = Number(body.price), old = body.old_price === '' || body.old_price == null ? null : Number(body.old_price);
  const stock = Number(body.stock);
  if (!name || name.length > 200 || !category || category.length > 100 || description.length > 5000 || emoji.length > 30 || image.length > 500 ||
      (image && !/^https:\/\//i.test(image)) || !Number.isFinite(price) || price < 0 || price > 99999999 ||
      (old !== null && (!Number.isFinite(old) || old < 0 || old > 99999999)) || !Number.isInteger(stock) || stock < 0 || stock > 1000000) return null;
  return [name,category,description,price,old,emoji,image || null,stock];
}
app.get('/api/admin/categories',auth,async(req,res)=>{
  try{const [rows]=await pool.query('SELECT c.id,c.name,COUNT(p.id) AS products FROM categories c LEFT JOIN products p ON p.category=c.name GROUP BY c.id,c.name ORDER BY c.name');res.json(rows)}catch(e){console.error(e);res.status(500).json({error:'Could not load categories'})}
});
app.post('/api/admin/categories',auth,async(req,res)=>{
  const name=String(req.body?.name||'').trim();
  if(!name||name.length>100)return res.status(400).json({error:'Category name must be 1–100 characters'});
  try{const [r]=await pool.execute('INSERT INTO categories(name) VALUES(?)',[name]);res.status(201).json({id:r.insertId,name})}catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'Category already exists'});console.error(e);res.status(500).json({error:'Could not add category'})}
});
app.delete('/api/admin/categories/:id',auth,async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid category'});
  try{const [rows]=await pool.execute('SELECT c.name,COUNT(p.id) AS n FROM categories c LEFT JOIN products p ON p.category=c.name WHERE c.id=? GROUP BY c.id,c.name',[id]);if(!rows.length)return res.status(404).json({error:'Category not found'});if(rows[0].n)return res.status(409).json({error:'Move or delete products in this category first'});await pool.execute('DELETE FROM categories WHERE id=?',[id]);res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Could not delete category'})}
});
app.get('/api/admin/summary',auth,async(req,res)=>{
  try {
    const [[products],[orders],[sales],[low]] = await Promise.all([
      pool.query('SELECT COUNT(*) AS n FROM products'),
      pool.query('SELECT COUNT(*) AS n FROM orders'),
      pool.query('SELECT COALESCE(SUM(total),0) AS n FROM orders WHERE status != ?', ['Cancelled']),
      pool.query('SELECT COUNT(*) AS n FROM products WHERE stock < 5')
    ]);
    res.json({products:products[0].n,orders:orders[0].n,sales:sales[0].n,lowStock:low[0].n});
  } catch(e){ console.error(e);res.status(500).json({error:'Could not load summary'}); }
});
app.get('/api/admin/products',auth,async(req,res)=>{
  try { const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');res.json(rows); }
  catch(e){console.error(e);res.status(500).json({error:'Could not load products'});}
});
app.post('/api/admin/products',auth,async(req,res)=>{
  const values=parseProduct(req.body);
  if(!values)return res.status(400).json({error:'Invalid product details. Image must be an HTTPS URL.'});
  try {const [cat]=await pool.execute('SELECT id FROM categories WHERE name=?',[values[1]]);if(!cat.length)return res.status(400).json({error:'Create the category first'});const [r]=await pool.execute(`INSERT INTO products (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,values);res.status(201).json({id:r.insertId});}
  catch(e){console.error(e);res.status(500).json({error:'Could not create product'});}
});
app.put('/api/admin/products/:id',auth,async(req,res)=>{
  const id=Number(req.params.id),values=parseProduct(req.body);
  if(!Number.isInteger(id)||id<1||!values)return res.status(400).json({error:'Invalid product details'});
  try {const [cat]=await pool.execute('SELECT id FROM categories WHERE name=?',[values[1]]);if(!cat.length)return res.status(400).json({error:'Create the category first'});const [r]=await pool.execute(`UPDATE products SET ${fields.map(x=>x+'=?').join(',')} WHERE id=?`,[...values,id]);if(!r.affectedRows)return res.status(404).json({error:'Product not found'});res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Could not update product'});}
});
app.delete('/api/admin/products/:id',auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid product ID'});
  try {const [r]=await pool.execute('DELETE FROM products WHERE id=?',[id]);if(!r.affectedRows)return res.status(404).json({error:'Product not found'});res.json({ok:true});}
  catch(e){if(e.code==='ER_ROW_IS_REFERENCED_2')return res.status(409).json({error:'This product belongs to an order. Set its stock to 0 instead.'});console.error(e);res.status(500).json({error:'Could not delete product'});}
});
app.get('/api/admin/orders',auth,async(req,res)=>{
  try {const [rows]=await pool.query('SELECT * FROM orders ORDER BY created_at DESC,id DESC LIMIT 500');res.json(rows);}
  catch(e){console.error(e);res.status(500).json({error:'Could not load orders'});}
});
app.get('/api/admin/orders/:id/items',auth,async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid order ID'});
  try {const [rows]=await pool.execute('SELECT oi.quantity,oi.unit_price,p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?',[id]);res.json(rows);}
  catch(e){console.error(e);res.status(500).json({error:'Could not load items'});}
});
app.patch('/api/admin/orders/:id/status',auth,async(req,res)=>{
  const allowed=['New','Processing','Shipped','On the way','Delivered','Cancelled'];
  const id=Number(req.params.id),status=req.body?.status;
  if(!Number.isInteger(id)||id<1||!allowed.includes(status))return res.status(400).json({error:'Invalid order or status'});
  try {const [r]=await pool.execute('UPDATE orders SET status=? WHERE id=?',[status,id]);if(!r.affectedRows)return res.status(404).json({error:'Order not found'});res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Could not update order'});}
});

initialize().then(() => {
  const port = Number(process.env.PORT || 3000);

  app.listen(port, '0.0.0.0', () => {
    console.log(`Maa Bhagwati General Store server running on port ${port}`);
  });

}).catch(error => {
  console.error(
    'Database initialization failed. Run database/schema.sql and check .env:',
    error.message
  );
  process.exit(1);
});
