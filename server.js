// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const morgan = require("morgan");
const helmet = require("helmet");

const app = express();

/* =========================
   ENV REQUIRED (.env sample)
   =========================
MONGO_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/tanuku_run
RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_KEY_SECRET=xxxxxxxx
SMTP_FROM_NAME=Tanuku Road Run 2025
SMTP_FROM_EMAIL=youremail@gmail.com
SMTP_PASS=your-gmail-app-password
ADMIN_EMAIL=youremail@gmail.com
PORT=5000
ALLOW_ORIGINS=https://your-frontend-domain.com,http://localhost:5173
*/

const {
  MONGO_URI,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  SMTP_FROM_NAME,
  SMTP_FROM_EMAIL,
  SMTP_PASS,
  ADMIN_EMAIL,
  PORT = 5000,
  ALLOW_ORIGINS,
} = process.env;

// ---------- Middleware ----------
app.use(express.json({ limit: "1mb" }));
app.use(helmet());
app.use(morgan("tiny"));

// CORS (allow list)
const allowList = (ALLOW_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowList.includes("*") || allowList.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: false,
  })
);

// ---------- MongoDB ----------
mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connect error:", err);
    process.exit(1);
  });

// ---------- Schemas ----------
const registrationSchema = new mongoose.Schema({
  runType: { type: String, required: true },
  name: String,
  email: String,
  phone: String,
  age: Number,
  gender: String,
  city: String,
  bloodGroup: String,
  tshirtSize: String,
  amount: Number, // in paise
  paymentId: String,
  orderId: String,
  signature: String,
  createdAt: { type: Date, default: Date.now },
});
const Registration = mongoose.model("Registration", registrationSchema);

const pendingSchema = new mongoose.Schema({
  runType: { type: String, required: true },
  name: String,
  email: String,
  phone: String,
  age: Number,
  gender: String,
  city: String,
  bloodGroup: String,
  tshirtSize: String,
  amount: Number, // in paise
  orderId: { type: String, index: true, unique: true },
  key: String,
  createdAt: { type: Date, default: Date.now, index: true },
});
const PendingOrder = mongoose.model("PendingOrder", pendingSchema);

// ---------- Razorpay ----------
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ---------- Nodemailer ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: SMTP_FROM_EMAIL, pass: SMTP_PASS },
});

// ---------- Prices ----------
const priceMappingRupees = { "3K": 250, "5K": 300, "10K": 350 };

// ---------- Routes ----------
app.get("/api/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// Create order (saves a pending document)
app.post("/api/create-order", async (req, res) => {
  try {
    const { raceType, name, email, phone, age, gender, city, bloodGroup, tshirtSize } = req.body;

    if (!raceType || !priceMappingRupees[raceType]) {
      return res.status(400).json({ success: false, error: "Invalid raceType" });
    }

    const amountInPaise = priceMappingRupees[raceType] * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      payment_capture: 1,
    });

    await new PendingOrder({
      runType: raceType,
      name,
      email,
      phone,
      age,
      gender,
      city,
      bloodGroup,
      tshirtSize,
      amount: amountInPaise,
      orderId: order.id,
      key: RAZORPAY_KEY_ID,
    }).save();

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    // Handle duplicate key on orderId (rare)
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: "Duplicate order, please retry." });
    }
    res.status(500).json({ success: false, error: "Server error creating order" });
  }
});

// Resume order (optional helper)
app.get("/api/resume-order/:orderId", async (req, res) => {
  try {
    const pending = await PendingOrder.findOne({ orderId: req.params.orderId }).lean();
    if (!pending) return res.status(404).json({ success: false, error: "Pending order not found" });
    res.json({ success: true, data: pending });
  } catch (err) {
    console.error("resume-order error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Verify payment + save registration + send email
app.post("/api/register", async (req, res) => {
  try {
    const {
      runType,
      name,
      email,
      phone,
      age,
      gender,
      city,
      bloodGroup,
      tshirtSize,
      paymentId,
      orderId,
      signature,
    } = req.body;

    // Validate basics
    if (!paymentId || !orderId || !signature) {
      return res.status(400).json({ success: false, error: "Missing payment details" });
    }

    // Fetch pending
    const pending = await PendingOrder.findOne({ orderId });
    if (!pending) return res.status(400).json({ success: false, error: "Pending order not found" });

    // Verify Razorpay signature
    const generatedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (generatedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }

    // Verify payment is captured
    const payment = await razorpay.payments.fetch(paymentId).catch(() => null);
    if (!payment || payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured" });
    }

    // Save final registration
    const reg = await new Registration({
      runType: runType || pending.runType,
      name: name || pending.name,
      email: email || pending.email,
      phone: phone || pending.phone,
      age: age || pending.age,
      gender: gender || pending.gender,
      city: city || pending.city,
      bloodGroup: bloodGroup || pending.bloodGroup,
      tshirtSize: tshirtSize || pending.tshirtSize,
      amount: pending.amount,
      paymentId,
      orderId,
      signature,
    }).save();

    // Remove pending
    await PendingOrder.deleteOne({ orderId });

    // Send email (to runner, BCC admin)
    const amountRupees = (pending.amount / 100).toFixed(0);
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6">
        <h2>Thank you for registering, ${reg.name}!</h2>
        <p>Your registration for <strong>${reg.runType}</strong> is confirmed.</p>
        <p><strong>Amount Paid:</strong> ₹${amountRupees}</p>
        <p><strong>Payment ID:</strong> ${paymentId}</p>
        <p><strong>Order ID:</strong> ${orderId}</p>
        <hr/>
        <p><strong>Details</strong></p>
        <ul>
          <li>Name: ${reg.name}</li>
          <li>Email: ${reg.email}</li>
          <li>Phone: ${reg.phone}</li>
          <li>Age/Gender: ${reg.age} / ${reg.gender}</li>
          <li>City: ${reg.city}</li>
          <li>Blood Group: ${reg.bloodGroup}</li>
          <li>T-Shirt Size: ${reg.tshirtSize}</li>
        </ul>
        <p>See you at Tanuku Road Run 2025! 🏃‍♀️🏃‍♂️</p>
      </div>
    `;

    transporter.sendMail(
      {
        from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
        to: reg.email,
        bcc: ADMIN_EMAIL || undefined, // remove BCC if you don't want admin copy
        subject: `Registration Successful – ${reg.runType}`,
        html,
      },
      (err, info) => {
        if (err) console.error("Email send error:", err);
        else console.log("Email sent:", info.response);
      }
    );

    res.json({ success: true, id: reg._id });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Admin: list registrations (protect behind a secret/token in real use)
app.get("/api/registrations", async (_, res) => {
  try {
    const regs = await Registration.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: regs });
  } catch (err) {
    console.error("registrations error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
