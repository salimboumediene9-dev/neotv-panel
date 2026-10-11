require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === "production";
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before starting.");
  process.exit(1);
}
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "panel.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
 id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 duration TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
 product_id INTEGER NOT NULL REFERENCES products(id), status TEXT NOT NULL DEFAULT 'pending',
 payment_status TEXT NOT NULL DEFAULT 'unpaid', customer_note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
 encrypted_details TEXT NOT NULL, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const adminCount = db.prepare("SELECT COUNT(*) AS n FROM admins").get().n;
if (adminCount === 0) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
  db.prepare("INSERT INTO admins(email,password_hash) VALUES(?,?)")
    .run(process.env.ADMIN_EMAIL.toLowerCase(), hash);
}
const productCount = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if (productCount === 0) {
  const add = db.prepare("INSERT INTO products(name,description,duration,price_cents) VALUES(?,?,?,?)");
  add.run("باقة أساسية", "اشتراك مناسب للاستخدام الشخصي، مع دعم فني.", "شهر واحد", 799);
  add.run("باقة مميزة", "مدة أطول وقيمة أفضل.", "3 أشهر", 1999);
  add.run("باقة سنوية", "اشتراك لمدة سنة كاملة.", "12 شهرًا", 5999);
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null
  }
}}));
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: dataDir }),
  name: "iptv.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: production, sameSite: "strict", maxAge: 1000 * 60 * 60 * 4 }
}));
app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", etag: true }));

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: "يلزم تسجيل دخول الإدارة." });
  next();
}
function cleanText(v, max=200) {
  return String(v ?? "").trim().replace(/[<>]/g, "").slice(0, max);
}
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && String(v).length <= 254; }
function priceCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) return null;
  return Math.round(n * 100);
}
function money(cents) { return (cents / 100).toFixed(2); }

app.get("/api/store", (req, res) => {
  const products = db.prepare("SELECT id,name,description,duration,price_cents FROM products WHERE active=1 ORDER BY price_cents").all()
    .map(p => ({ ...p, price: money(p.price_cents) }));
  res.json({ products, paymentMode: process.env.PAYMENT_PROVIDER === "manual" ? "manual" : "provider_pending" });
});

app.post("/api/orders", rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const name = cleanText(req.body.name, 100);
  const email = cleanText(req.body.email, 254).toLowerCase();
  const note = cleanText(req.body.note, 500);
  const productId = Number(req.body.productId);
  if (name.length < 2 || !validEmail(email) || !Number.isInteger(productId)) {
    return res.status(400).json({ error: "يرجى إدخال الاسم والبريد واختيار باقة صحيحة." });
  }
  const product = db.prepare("SELECT id FROM products WHERE id=? AND active=1").get(productId);
  if (!product) return res.status(400).json({ error: "هذه الباقة غير متاحة حاليًا." });
  const create = db.transaction(() => {
    let customer = db.prepare("SELECT id FROM customers WHERE email=?").get(email);
    if (!customer) {
      const info = db.prepare("INSERT INTO customers(name,email) VALUES(?,?)").run(name, email);
      customer = { id: info.lastInsertRowid };
    } else {
      db.prepare("UPDATE customers SET name=? WHERE id=?").run(name, customer.id);
    }
    const order = db.prepare("INSERT INTO orders(customer_id,product_id,status,payment_status,customer_note) VALUES(?,?, 'pending','unpaid',?)")
      .run(customer.id, productId, note);
    return order.lastInsertRowid;
  });
  const id = create();
  res.status(201).json({ ok: true, orderId: id, message: "تم استلام طلبك. سيظهر بعد مراجعته من الإدارة. لم يتم تحصيل أي مبلغ من هذه النسخة التجريبية." });
});

app.post("/api/login", async (req, res) => {
  const email = cleanText(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || "");
  const admin = db.prepare("SELECT id,email,password_hash FROM admins WHERE email=?").get(email);
  const ok = admin && await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة." });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "تعذر بدء الجلسة." });
    req.session.adminId = admin.id;
    req.session.adminEmail = admin.email;
    res.json({ ok: true, email: admin.email });
  });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => {
  res.clearCookie("iptv.sid", { httpOnly: true, sameSite: "strict", secure: production });
  res.json({ ok: true });
}));
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ email: req.session.adminEmail }));

app.get("/api/admin/summary", requireAdmin, (req, res) => {
  const customers = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  const orders = db.prepare("SELECT COUNT(*) n FROM orders").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='pending'").get().n;
  const paid = db.prepare("SELECT COUNT(*) n FROM orders WHERE payment_status='paid'").get().n;
  const revenue = db.prepare(`SELECT COALESCE(SUM(p.price_cents),0) n FROM orders o JOIN products p ON p.id=o.product_id WHERE o.payment_status='paid'`).get().n;
  res.json({ customers, orders, pending, paid, revenue: money(revenue) });
});
app.get("/api/admin/products", requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id,name,description,duration,price_cents,active FROM products ORDER BY id DESC").all()
    .map(p => ({ ...p, price: money(p.price_cents), active: Boolean(p.active) })));
});
app.post("/api/admin/products", requireAdmin, (req, res) => {
  const name = cleanText(req.body.name, 100);
  const description = cleanText(req.body.description, 500);
  const duration = cleanText(req.body.duration, 80);
  const cents = priceCents(req.body.price);
  if (name.length < 2 || !duration || cents === null) return res.status(400).json({ error: "تحقق من الاسم والمدة والسعر." });
  const result = db.prepare("INSERT INTO products(name,description,duration,price_cents,active) VALUES(?,?,?,?,1)")
    .run(name, description, duration, cents);
  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});
app.patch("/api/admin/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const active = req.body.active ? 1 : 0;
  if (!Number.isInteger(id)) return res.status(400).json({ error: "معرّف غير صحيح." });
  const result = db.prepare("UPDATE products SET active=? WHERE id=?").run(active, id);
  if (!result.changes) return res.status(404).json({ error: "المنتج غير موجود." });
  res.json({ ok: true });
});
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT o.id,o.status,o.payment_status,o.customer_note,o.created_at,
    c.name customer_name,c.email customer_email,p.name product_name,p.duration,p.price_cents,
    d.sent_at
    FROM orders o JOIN customers c ON c.id=o.customer_id JOIN products p ON p.id=o.product_id
    LEFT JOIN deliveries d ON d.order_id=o.id ORDER BY o.id DESC LIMIT 300`).all();
  res.json(rows.map(o => ({ ...o, price: money(o.price_cents), delivered: Boolean(o.sent_at) })));
});
app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || "");
  const payment = String(req.body.paymentStatus || "");
  if (!Number.isInteger(id) || !["pending","processing","completed","cancelled"].includes(status) ||
      !["unpaid","paid","refunded"].includes(payment)) return res.status(400).json({ error: "حالة الطلب غير صحيحة." });
  const result = db.prepare("UPDATE orders SET status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(status, payment, id);
  if (!result.changes) return res.status(404).json({ error: "الطلب غير موجود." });
  res.json({ ok: true });
});
app.get("/api/admin/customers", requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT c.id,c.name,c.email,c.created_at,COUNT(o.id) order_count
    FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY c.id DESC LIMIT 500`).all());
});

// Delivery details are encrypted at rest with AES-256-GCM using SESSION_SECRET-derived key.
const crypto = require("crypto");
const deliveryKey = crypto.createHash("sha256").update(process.env.SESSION_SECRET).digest();
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deliveryKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}
function decrypt(value) {
  const [iv, tag, data] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deliveryKey, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
}
app.post("/api/admin/orders/:id/delivery", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const details = String(req.body.details || "").trim().slice(0, 3000);
  if (!Number.isInteger(id) || details.length < 3) return res.status(400).json({ error: "أدخل بيانات الاشتراك." });
  const order = db.prepare("SELECT id,payment_status FROM orders WHERE id=?").get(id);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود." });
  if (order.payment_status !== "paid") return res.status(400).json({ error: "أكد الدفع أولًا قبل تسليم بيانات الاشتراك." });
  const sealed = encrypt(details);
  db.prepare(`INSERT INTO deliveries(order_id,encrypted_details,sent_at) VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET encrypted_details=excluded.encrypted_details,sent_at=CURRENT_TIMESTAMP`).run(id, sealed);
  db.prepare("UPDATE orders SET status='completed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  res.json({ ok: true, message: "تم حفظ بيانات التسليم بشكل مشفّر." });
});
app.get("/api/admin/orders/:id/delivery", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT encrypted_details,sent_at FROM deliveries WHERE order_id=?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "لا توجد بيانات تسليم لهذا الطلب." });
  try { res.json({ details: decrypt(row.encrypted_details), sentAt: row.sent_at }); }
  catch { res.status(500).json({ error: "تعذر فك تشفير البيانات؛ تحقق من SESSION_SECRET." }); }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`IPTV panel listening on http://localhost:${PORT}`));
