const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// ---------- MongoDB ----------
const MONGO_URI = "mongodb+srv://krishnasastry99:J12rfhtgXDzyBj2B@cluster0.zownxzc.mongodb.net/tanuku_run?retryWrites=true&w=majority";

mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connect error:", err);
    process.exit(1);
  });

// ---------- Schemas ----------
const registrationSchema = new mongoose.Schema({
  runType: String,
  name: String,
  email: String,
  phone: String,
  age: Number,
  gender: String,
  city: String,
  bloodGroup: String,
  tshirtSize: String,
  amount: Number,
  paymentId: String,
  orderId: String,
  signature: String,
  createdAt: { type: Date, default: Date.now },
});
const Registration = mongoose.model("Registration", registrationSchema);

const pendingSchema = new mongoose.Schema({
  runType: String,
  name: String,
  email: String,
  phone: String,
  age: Number,
  gender: String,
  city: String,
  bloodGroup: String,
  tshirtSize: String,
  amount: Number,
  orderId: String,
  key: String,
  createdAt: { type: Date, default: Date.now },
});
const PendingOrder = mongoose.model("PendingOrder", pendingSchema);

// ---------- Razorpay ----------
const RAZORPAY_KEY_ID = "rzp_test_E88wJ7EdIC51XD";
const RAZORPAY_KEY_SECRET = "1JtTw4DsO4kjGReBA7078ShY";

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ---------- Price mapping ----------
const priceMappingRupees = { "3K": 150, "5K": 300, "10K": 350 };

// ---------- Routes ----------

// Health check
app.get("/api/health", (_, res) => res.json({ ok: true }));

// Create order & save pending
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

    // Save pending order with all user info
    const pending = new PendingOrder({
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
    });
    await pending.save();

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ success: false, error: "Server error creating order" });
  }
});

// Resume pending order// Create order & save pending with detailed logging
app.post("/api/create-order", async (req, res) => {
  try {
    const { raceType, name, email, phone, age, gender, city, bloodGroup, tshirtSize } = req.body;
    console.log("Received /create-order request body:", req.body);

    // Validate raceType
    if (!raceType || !priceMappingRupees[raceType]) {
      console.error("Invalid raceType:", raceType);
      return res.status(400).json({ success: false, error: "Invalid raceType" });
    }

    const amountInPaise = priceMappingRupees[raceType] * 100;
    console.log("Amount in paise:", amountInPaise);

    // Create Razorpay order
    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: `rcpt_${Date.now()}`,
        payment_capture: 1,
      });
      console.log("Razorpay order created successfully:", order);
    } catch (err) {
      console.error("Razorpay order creation failed:", err);
      return res.status(500).json({ success: false, error: "Failed to create Razorpay order", details: err.message });
    }

    // Save pending order in MongoDB
    const pending = new PendingOrder({
      runType: raceType,
      name, email, phone, age, gender, city, bloodGroup, tshirtSize,
      amount: amountInPaise,
      orderId: order.id,
      key: RAZORPAY_KEY_ID,
    });

    try {
      await pending.save();
      console.log("Pending order saved in DB:", pending);
    } catch (err) {
      console.error("Failed to save pending order:", err);
      return res.status(500).json({ success: false, error: "Failed to save pending order", details: err.message });
    }

    // Return order details to frontend
    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Unexpected create-order error:", err);
    res.status(500).json({ success: false, error: "Server error creating order", details: err.message });
  }
});

app.get("/api/resume-order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const pending = await PendingOrder.findOne({ orderId });
    if (!pending) return res.status(404).json({ success: false, error: "Pending order not found" });

    res.json({ success: true, data: pending });
  } catch (err) {
    console.error("resume-order error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Complete registration / payment
app.post("/api/register", async (req, res) => {
  try {
    const { runType, name, email, phone, age, gender, city, bloodGroup, tshirtSize, paymentId, orderId, signature } = req.body;

    // Fetch pending order
    const pending = await PendingOrder.findOne({ orderId });
    if (!pending) return res.status(400).json({ success: false, error: "Pending order not found" });

    // Verify Razorpay signature
    const generatedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (generatedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Invalid signature." });
    }

    // Optional: verify payment status
    const payment = await razorpay.payments.fetch(paymentId).catch(() => null);
    if (!payment || payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured." });
    }

    // Save final registration
    const reg = new Registration({
      runType, name, email, phone, age, gender, city, bloodGroup, tshirtSize,
      amount: pending.amount, paymentId, orderId, signature
    });
    await reg.save();

    // Remove pending
    await PendingOrder.deleteOne({ orderId });

    res.json({ success: true, id: reg._id });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// List all registrations
app.get("/api/registrations", async (_, res) => {
  try {
    const regs = await Registration.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: regs });
  } catch (err) {
    console.error("registrations error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
