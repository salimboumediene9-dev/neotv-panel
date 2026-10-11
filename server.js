'use strict';

const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'neo-tv.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'reseller')),
    active INTEGER NOT NULL DEFAULT 1,
    balance_dzd INTEGER NOT NULL DEFAULT 0,
    balance_eur INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    product_type TEXT NOT NULL CHECK(product_type IN ('iptv', 'server')),
    duration_days INTEGER NOT NULL DEFAULT 30,
    price_dzd INTEGER NOT NULL DEFAULT 0,
    price_eur_cents INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unconfigured'
      CHECK(status IN ('online', 'offline', 'unconfigured')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
    currency TEXT NOT NULL CHECK(currency IN ('DZD', 'EUR')),
    total_amount INTEGER NOT NULL CHECK(total_amount >= 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'paid', 'completed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );
`);

const SQLiteStore = SQLiteStoreFactory(session);
const isProduction = NODE_ENV === 'production';

app.disable('x-powered-by');

if (isProduction) {
  // Configure the trusted reverse proxy correctly before production deployment.
  app.set('trust proxy', 1);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  console.error(
    'خطأ: عيّن SESSION_SECRET بطول 32 حرفًا على الأقل في متغيرات البيئة.'
  );
  process.exit(1);
}

app.use(session({
  name: 'neo_tv_session',
  secret: sessionSecret,
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: dataDir,
    concurrentDB: true
  }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.' }
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

app.use('/api', writeLimiter);

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'يرجى تسجيل الدخول أولًا.' });
  }

  const user = db.prepare(
    'SELECT id, username, role, active FROM users WHERE id = ?'
  ).get(req.session.user.id);

  if (!user || user.active !== 1) {
    return req.session.destroy(() => {
      res.status(401).json({ error: 'الحساب غير متاح. سجّل الدخول مجددًا.' });
    });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه العملية للمدير فقط.' });
  }
  next();
}

function validText(value, max = 120) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max;
}

function integerInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function parseProduct(body) {
  const {
    name, description = '', product_type, duration_days = 30,
    price_dzd = 0, price_eur_cents = 0, active = true
  } = body;

  if (!validText(name, 120)) {
    throw new Error('اسم المنتج مطلوب، والحد الأقصى 120 حرفًا.');
  }
  if (!['iptv', 'server'].includes(product_type)) {
    throw new Error('نوع المنتج غير صحيح.');
  }
  if (typeof description !== 'string' || description.length > 1000) {
    throw new Error('وصف المنتج غير صحيح.');
  }
  if (!integerInRange(duration_days, 1, 3650)) {
    throw new Error('مدة المنتج يجب أن تكون بين يوم و3650 يومًا.');
  }
  if (!integerInRange(price_dzd, 0, 1000000000) ||
      !integerInRange(price_eur_cents, 0, 1000000000)) {
    throw new Error('الأسعار يجب أن تكون أعدادًا صحيحة غير سالبة.');
  }
  if (typeof active !== 'boolean') {
    throw new Error('حالة المنتج غير صحيحة.');
  }

  return {
    name: name.trim(),
    description: description.trim(),
    product_type,
    duration_days,
    price_dzd,
    price_eur_cents,
    active: active ? 1 : 0
  };
}

// Create the first administrator from environment variables.
// No default password is created.
async function initializeAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.warn(
      'لم يتم إعداد المدير الأول. عيّن ADMIN_USERNAME وADMIN_PASSWORD.'
    );
    return;
  }

  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
    throw new Error('ADMIN_USERNAME يجب أن يكون من 3 إلى 40 حرفًا أو رقمًا.');
  }

  if (password.length < 12 || password.length > 200) {
    throw new Error('كلمة مرور المدير يجب أن تكون بين 12 و200 حرف.');
  }

  const existing = db.prepare(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  ).get();

  if (existing) return;

  const passwordHash = await bcrypt.hash(password, 12);

  db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, 'admin')
  `).run(username, passwordHash);

  console.log('تم إنشاء حساب المدير الأول.');
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', application: 'NEO TV PANEL' });
});

app.post('/api/auth/login', loginLimiter, (req, res, next) => {
  const { username, password } = req.body || {};

  if (!validText(username, 40) ||
      typeof password !== 'string' ||
      password.length > 200) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور.' });
  }

  const user = db.prepare(`
    SELECT id, username, password_hash, role, active
    FROM users
    WHERE username = ?
  `).get(username.trim());

  Promise.resolve()
    .then(async () => {
      if (!user || user.active !== 1 ||
          !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
      }

      req.session.regenerate(err => {
        if (err) return next(err);

        req.session.user = {
          id: user.id,
          username: user.username,
          role: user.role
        };

        req.session.save(saveErr => {
          if (saveErr) return next(saveErr);

          res.json({
            message: 'تم تسجيل الدخول.',
            user: {
              id: user.id,
              username: user.username,
              role: user.role
            }
          });
        });
      });
    })
    .catch(next);
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/logout', requireAuth, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('neo_tv_session', {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax'
    });
    res.json({ message: 'تم تسجيل الخروج.' });
  });
});

// Dashboard data is private and loaded from the database.
app.get('/api/dashboard', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin';

  const products = db.prepare(
    'SELECT COUNT(*) AS count FROM products WHERE active = 1'
  ).get().count;

  const orders = isAdmin
    ? db.prepare('SELECT COUNT(*) AS count FROM orders').get().count
    : db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id = ?')
        .get(req.user.id).count;

  const activeUsers = isAdmin
    ? db.prepare("SELECT COUNT(*) AS count FROM users WHERE active = 1").get().count
    : null;

  const recentOrders = isAdmin
    ? db.prepare(`
        SELECT o.id, o.quantity, o.currency, o.total_amount, o.status,
               o.created_at, u.username, p.name AS product_name
        FROM orders o
        JOIN users u ON u.id = o.user_id
        JOIN products p ON p.id = o.product_id
        ORDER BY o.id DESC LIMIT 10
      `).all()
    : db.prepare(`
        SELECT o.id, o.quantity, o.currency, o.total_amount, o.status,
               o.created_at, p.name AS product_name
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE o.user_id = ?
        ORDER BY o.id DESC LIMIT 10
      `).all(req.user.id);

  res.json({
    currency_options: ['DZD', 'EUR'],
    active_products: products,
    orders_count: orders,
    active_users: activeUsers,
    recent_orders: recentOrders
  });
});

// Product management
app.get('/api/products', requireAuth, (req, res) => {
  const products = db.prepare(`
    SELECT id, name, description, product_type, duration_days,
           price_dzd, price_eur_cents, active, created_at
    FROM products
    ${req.user.role === 'admin' ? '' : 'WHERE active = 1'}
    ORDER BY id DESC
  `).all();

  res.json({ products });
});

app.post('/api/products', requireAuth, requireAdmin, (req, res) => {
  let product;
  try {
    product = parseProduct(req.body || {});
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const result = db.prepare(`
    INSERT INTO products
      (name, description, product_type, duration_days,
       price_dzd, price_eur_cents, active)
    VALUES
      (@name, @description, @product_type, @duration_days,
       @price_dzd, @price_eur_cents, @active)
  `).run(product);

  res.status(201).json({
    message: 'تمت إضافة المنتج.',
    id: result.lastInsertRowid
  });
});

app.put('/api/products/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!integerInRange(id, 1, Number.MAX_SAFE_INTEGER)) {
    return res.status(400).json({ error: 'رقم المنتج غير صحيح.' });
  }

  let product;
  try {
    product = parseProduct(req.body || {});
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const result = db.prepare(`
    UPDATE products
    SET name=@name, description=@description, product_type=@product_type,
        duration_days=@duration_days, price_dzd=@price_dzd,
        price_eur_cents=@price_eur_cents, active=@active
    WHERE id=@id
  `).run({ ...product, id });

  if (!result.changes) {
    return res.status(404).json({ error: 'المنتج غير موجود.' });
  }

  res.json({ message: 'تم تعديل المنتج.' });
});

app.delete('/api/products/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!integerInRange(id, 1, Number.MAX_SAFE_INTEGER)) {
    return res.status(400).json({ error: 'رقم المنتج غير صحيح.' });
  }

  // Keep historical orders intact: deactivate instead of deleting.
  const result = db.prepare(
    'UPDATE products SET active = 0 WHERE id = ?'
  ).run(id);

  if (!result.changes) {
    return res.status(404).json({ error: 'المنتج غير موجود.' });
  }

  res.json({ message: 'تم إيقاف المنتج.' });
});

// Server inventory. Real connectivity checks must be implemented separately.
app.get('/api/servers', requireAuth, requireAdmin, (req, res) => {
  const servers = db.prepare(`
    SELECT id, name, host, status, created_at
    FROM servers ORDER BY id DESC
  `).all();

  res.json({ servers });
});

app.post('/api/servers', requireAuth, requireAdmin, (req, res) => {
  const { name, host } = req.body || {};

  if (!validText(name, 120) || !validText(host, 255)) {
    return res.status(400).json({ error: 'اسم السيرفر وعنوانه مطلوبان.' });
  }

  const result = db.prepare(`
    INSERT INTO servers (name, host, status)
    VALUES (?, ?, 'unconfigured')
  `).run(name.trim(), host.trim());

  res.status(201).json({
    message: 'تم تسجيل السيرفر. لم يتم التحقق من اتصاله بعد.',
    id: result.lastInsertRowid
  });
});

// Create an order using prices stored on the server, never client-supplied prices.
app.post('/api/orders', requireAuth, (req, res) => {
  const { product_id, quantity = 1, currency } = req.body || {};
  const productId = Number(product_id);

  if (!integerInRange(productId, 1, Number.MAX_SAFE_INTEGER) ||
      !integerInRange(quantity, 1, 100) ||
      !['DZD', 'EUR'].includes(currency)) {
    return res.status(400).json({ error: 'بيانات الطلب غير صحيحة.' });
  }

  const product = db.prepare(`
    SELECT id, price_dzd, price_eur_cents, active
    FROM products WHERE id = ?
  `).get(productId);

  if (!product || product.active !== 1) {
    return res.status(404).json({ error: 'المنتج غير متاح.' });
  }

  const unitPrice = currency === 'DZD'
    ? product.price_dzd
    : product.price_eur_cents;

  const total = unitPrice * quantity;

  if (!Number.isSafeInteger(total)) {
    return res.status(400).json({ error: 'إجمالي الطلب أكبر من المسموح.' });
  }

  const result = db.prepare(`
    INSERT INTO orders (user_id, product_id, quantity, currency, total_amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, product.id, quantity, currency, total);

  res.status(201).json({
    message: 'تم إنشاء الطلب وهو بانتظار المراجعة.',
    order_id: result.lastInsertRowid,
    currency,
    total_amount: total,
    status: 'pending'
  });
});

app.get('/api/orders', requireAuth, (req, res) => {
  const orders = req.user.role === 'admin'
    ? db.prepare(`
        SELECT o.id, o.quantity, o.currency, o.total_amount, o.status,
               o.created_at, u.username, p.name AS product_name
        FROM orders o
        JOIN users u ON u.id = o.user_id
        JOIN products p ON p.id = o.product_id
        ORDER BY o.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT o.id, o.quantity, o.currency, o.total_amount, o.status,
               o.created_at, p.name AS product_name
        FROM orders o
        JOIN products p ON p.id = o.product_id
        WHERE o.user_id = ?
        ORDER BY o.id DESC LIMIT 200
      `).all(req.user.id);

  res.json({ orders });
});

// Serve the front-end files.
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'مسار API غير موجود.' });
});

app.get('*', (req, res, next) => {
  if (req.method !== 'GET' || path.extname(req.path)) {
    return res.status(404).send('الصفحة غير موجودة.');
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'), error => {
    if (error) next(error);
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);

  if (res.headersSent) return next(err);

  res.status(500).json({
    error: 'حدث خطأ داخلي في الخادم.'
  });
});

initializeAdmin()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(NEO TV PANEL يعمل على المنفذ ${PORT});
    });
  })
  .catch(error => {
    console.error('تعذّر تهيئة المشروع:', error.message);
    process.exit(1);
  });

function shutdown() {
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
