require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// User Schema
const userSchema = new mongoose.Schema({
  runType: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  age: { type: Number, required: true },
  gender: { type: String, required: true },
  city: { type: String, required: true },
  bloodGroup: { type: String, required: true },
  tshirtSize: { type: String, required: true },
  paymentId: String,
  orderId: String,
  signature: String,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Create Razorpay order
app.post("/api/create-order", async (req, res) => {
  try {
    const { raceType } = req.body;
    const priceMapping = { "3K": 250, "5K": 300, "10K": 350 };
    const price = priceMapping[raceType];

    if (!price) {
      return res.status(400).json({ success: false, error: "Invalid run type." });
    }

    const amount = price * 100; // Razorpay amount in paise

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ success: false, error: "Failed to create order." });
  }
});

// Register user after payment
app.post("/api/register", async (req, res) => {
  try {
    const { runType, name, email, phone, age, gender, city, bloodGroup, tshirtSize, paymentId, orderId, signature } = req.body;

    // Backend validation
    if (!runType || !name || !email || !phone || !age || !gender || !city || !bloodGroup || !tshirtSize) {
      return res.status(400).json({ success: false, error: "All fields are required." });
    }
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ success: false, error: "Invalid phone number." });
    if (!/^\d{1,3}$/.test(String(age))) return res.status(400).json({ success: false, error: "Invalid age." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: "Invalid email." });

    // Verify Razorpay payment signature
    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    hmac.update(`${orderId}|${paymentId}`);
    const generatedSignature = hmac.digest("hex");

    if (generatedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Payment verification failed." });
    }

    // Save user
    const newUser = new User({ runType, name, email, phone, age, gender, city, bloodGroup, tshirtSize, paymentId, orderId, signature });
    await newUser.save();

    res.json({ success: true, message: "User registered successfully." });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ success: false, error: "Registration failed." });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
