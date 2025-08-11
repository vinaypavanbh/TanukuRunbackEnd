// server.js (CommonJS)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// CORS (allow your frontend origin)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "sessionId"],
    exposedHeaders: ["sessionId"],
  })
);
app.options("*", cors());

// ---------- MongoDB ----------
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://krishnasastry99:J12rfhtgXDzyBj2B@cluster0.zownxzc.mongodb.net/tanuku_run?retryWrites=true&w=majority&appName=Cluster0";

mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connect error:", err);
    process.exit(1);
  });

// ---------- Model ----------
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
  amount: Number, // in paise
  paymentId: String,
  orderId: String,
  signature: String,
  createdAt: { type: Date, default: Date.now },
});
const Registration = mongoose.model("Registration", registrationSchema);

// ---------- Razorpay ----------
const RAZORPAY_KEY_ID = "rzp_test_E88wJ7EdIC51XD";
const RAZORPAY_KEY_SECRET = "1JtTw4DsO4kjGReBA7078ShY";

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ---------- Price mapping (server authoritative) ----------
const priceMappingRupees = {
  "3K": 150,
  "5K": 300,
  "10K": 500,
};

// ---------- Routes ----------
// Health check
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Create order: frontend sends { raceType }
app.post("/api/create-order", async (req, res) => {
  try {
    const { raceType } = req.body;
    if (!raceType || !priceMappingRupees[raceType]) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid raceType" });
    }

    const amountInPaise = priceMappingRupees[raceType] * 100;

    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);

    return res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Server error creating order" });
  }
});

/*
  Register endpoint:
  Expects JSON with at least:
  {
    runType, name, email, phone, age, gender, city, bloodGroup, tshirtSize,
    paymentId, orderId, signature
  }

  Steps:
   - Verify signature using razorpay secret
   - (Optional) Fetch order/payment from Razorpay to confirm amounts/status
   - Save registration to MongoDB
*/
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

    if (!orderId || !paymentId || !signature) {
      return res
        .status(400)
        .json({ success: false, error: "Missing payment information" });
    }

    // 1) Verify signature
    const generatedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    if (generatedSignature !== signature) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid signature" });
    }

    // 2) Optional: fetch order & payment to double-check amount and status
    // Fetch order
    const order = await razorpay.orders.fetch(orderId).catch((err) => {
      console.warn("Could not fetch order from Razorpay:", err && err.message);
      return null;
    });

    // Fetch payment
    const payment = await razorpay.payments.fetch(paymentId).catch((err) => {
      console.warn(
        "Could not fetch payment from Razorpay:",
        err && err.message
      );
      return null;
    });

    // Confirm payment captured and amount matches server-side mapping
    const expectedAmount = priceMappingRupees[runType]
      ? priceMappingRupees[runType] * 100
      : null;
    if (expectedAmount === null) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid runType for verification" });
    }

    if (order && Number(order.amount) !== Number(expectedAmount)) {
      console.warn("Order amount mismatch", {
        orderAmount: order.amount,
        expectedAmount,
      });
      return res
        .status(400)
        .json({ success: false, error: "Order amount mismatch" });
    }

    if (payment && payment.status !== "captured") {
      console.warn("Payment status not captured:", payment && payment.status);
      // Note: in some test scenarios status may be 'authorized' then later 'captured'
      // We require 'captured' here to save registration
      return res
        .status(400)
        .json({ success: false, error: "Payment not captured" });
    }

    // 3) Persist registration
    const reg = new Registration({
      runType,
      name,
      email,
      phone,
      age,
      gender,
      city,
      bloodGroup,
      tshirtSize,
      amount: expectedAmount, // paise
      paymentId,
      orderId,
      signature,
    });

    await reg.save();

    return res.json({ success: true, id: reg._id });
  } catch (err) {
    console.error("register error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Server error saving registration" });
  }
});

// Admin: get all registrations (for testing)
app.get("/api/registrations", async (req, res) => {
  try {
    const regs = await Registration.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: regs });
  } catch (err) {
    console.error("registrations error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// Start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);