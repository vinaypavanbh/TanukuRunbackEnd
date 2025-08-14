// server.js (Secure & Robust Version)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
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
  status: { type: String, enum: ["PENDING", "PAID", "FAILED", "CANCELLED"], default: "PENDING" },
  createdAt: { type: Date, default: Date.now },
});
const Registration = mongoose.model("Registration", registrationSchema);

// ---------- Razorpay ----------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ---------- Price mapping ----------
const priceMappingRupees = {
  "3K": 150,
  "5K": 300,
  "10K": 350,
};

// ---------- Routes ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Create Razorpay order
app.post("/api/create-order", async (req, res) => {
  try {
    const { raceType } = req.body;
    if (!raceType || !priceMappingRupees[raceType]) {
      return res.status(400).json({ success: false, error: "Invalid raceType" });
    }

    const amountInPaise = priceMappingRupees[raceType] * 100;
    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      payment_capture: 1,
    };

    const order = await razorpay.orders.create(options);

    // Save order in MongoDB with PENDING status
    const registration = new Registration({
      runType: raceType,
      orderId: order.id,
      amount: amountInPaise,
      status: "PENDING",
    });
    await registration.save();

    return res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("create-order error:", err);
    return res.status(500).json({ success: false, error: "Server error creating order" });
  }
});

// Register after payment verification
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
      return res.status(400).json({ success: false, error: "Missing payment information" });
    }

    // Fetch registration/order from DB
    const registration = await Registration.findOne({ orderId });
    if (!registration) {
      return res.status(400).json({ success: false, error: "Order not found" });
    }

    // Prevent duplicate payment registration
    if (registration.status === "PAID") {
      return res.status(409).json({ success: false, error: "Already registered for this order" });
    }

    // Verify signature
    const generatedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    if (generatedSignature !== signature) {
      registration.status = "FAILED";
      await registration.save();
      return res.status(400).json({ success: false, error: "Invalid payment signature" });
    }

    // Verify order details from Razorpay
    const order = await razorpay.orders.fetch(orderId);
    if (!order) return res.status(400).json({ success: false, error: "Order not found in Razorpay" });

    const expectedAmount = priceMappingRupees[runType] * 100;
    if (Number(order.amount) !== expectedAmount) {
      registration.status = "FAILED";
      await registration.save();
      return res.status(400).json({ success: false, error: "Order amount mismatch" });
    }

    // Verify payment
    const payment = await razorpay.payments.fetch(paymentId);
    if (!payment || payment.status !== "captured" || payment.order_id !== orderId) {
      registration.status = "FAILED";
      await registration.save();
      return res.status(400).json({ success: false, error: "Payment not completed or mismatched" });
    }

    // Save full registration
    registration.name = name;
    registration.email = email;
    registration.phone = phone;
    registration.age = age;
    registration.gender = gender;
    registration.city = city;
    registration.bloodGroup = bloodGroup;
    registration.tshirtSize = tshirtSize;
    registration.paymentId = paymentId;
    registration.signature = signature;
    registration.status = "PAID";

    await registration.save();

    return res.json({ success: true, id: registration._id });
  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ success: false, error: "Server error saving registration" });
  }
});

// Cancel pending order (for Go Back / abandoned payment)
app.post("/api/cancel-order", async (req, res) => {
  try {
    const { orderId } = req.body;
    const registration = await Registration.findOne({ orderId });
    if (!registration || registration.status !== "PENDING") {
      return res.status(400).json({ success: false, error: "Order cannot be cancelled" });
    }

    registration.status = "CANCELLED";
    await registration.save();

    return res.json({ success: true, message: "Order cancelled successfully" });
  } catch (err) {
    console.error("cancel-order error:", err);
    return res.status(500).json({ success: false, error: "Failed to cancel order" });
  }
});

// Fetch all registrations
app.get("/api/registrations", async (req, res) => {
  try {
    const regs = await Registration.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: regs });
  } catch (err) {
    console.error("registrations error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
