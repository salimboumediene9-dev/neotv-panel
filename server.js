const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "NeoTV Panel", mode: "demo" });
});

// Demo endpoint only: orders are not saved to a database and no payment is taken.
app.post("/api/orders", (req, res) => {
  const { productId, customerName, contact } = req.body || {};
  if (!productId || !customerName || !contact) {
    return res.status(400).json({ ok: false, message: "يرجى ملء جميع الحقول." });
  }
  res.status(201).json({
    ok: true,
    message: "تم تسجيل الطلب التجريبي. اربط قاعدة بيانات وبوابة دفع قبل استقبال العملاء.",
    order: {
      id: "DEMO-" + Date.now().toString().slice(-7),
      productId,
      customerName: String(customerName).slice(0, 100),
      contact: String(contact).slice(0, 120),
      status: "pending"
    }
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NeoTV Panel running on port ${PORT}`);
});