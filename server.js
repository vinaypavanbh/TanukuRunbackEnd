// server.js
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const morgan = require("morgan");
const helmet = require("helmet");

const app = express();

// ================== CONFIG (hardcoded instead of .env) ==================
const MONGO_URI =
  "mongodb+srv://krishnasastry99:J12rfhtgXDzyBj2B@cluster0.zownxzc.mongodb.net/tanuku_run?retryWrites=true&w=majority";
const RAZORPAY_KEY_ID = "rzp_live_R5uzxh2ODPYjrn";
const RAZORPAY_KEY_SECRET = "dRVP063bPmjvKQi3wZPiR9T7";
const SMTP_FROM_NAME = "Tanuku Road Run 2025";
const SMTP_FROM_EMAIL = "youremail@gmail.com"; // 👈 replace with Gmail
const SMTP_PASS = "your-gmail-app-password"; // 👈 replace with Gmail App password
const ADMIN_EMAIL = "youremail@gmail.com";
const PORT = 5000;
const ALLOW_ORIGINS =
  "http://localhost:5173,https://your-frontend-domain.com";

// ================== MIDDLEWARE ==================
app.use(express.json());
app.use(morgan("dev"));
app.use(helmet());
app.use(
  cors({
    origin: ALLOW_ORIGINS.split(","),
    credentials: true,
  })
);

// ================== DB CONNECT ==================
mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ================== SCHEMA ==================
const RegistrationSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
    age: Number,
    category: String,
    price: Number,
    paymentId: String,
    orderId: String,
    status: { type: String, default: "pending" },
  },
  { timestamps: true }
);

const Registration = mongoose.model("Registration", RegistrationSchema);

// ================== RAZORPAY ==================
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ================== EMAIL TRANSPORT ==================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: SMTP_FROM_EMAIL,
    pass: SMTP_PASS,
  },
});

// ================== ROUTES ==================

// Health check
app.get("/", (req, res) => {
  res.send("🚀 Tanuku Run backend is running!");
});

// Create Razorpay order
app.post("/api/order", async (req, res) => {
  try {
    const { amount, name, email, phone, age, category } = req.body;

    const options = {
      amount: amount * 100, // in paisa
      currency: "INR",
      receipt: "receipt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);

    const newReg = new Registration({
      name,
      email,
      phone,
      age,
      category,
      price: amount,
      orderId: order.id,
      status: "created",
    });
    await newReg.save();

    res.json({ orderId: order.id, key: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Verify payment
app.post("/api/verify", async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;

    const generatedSig = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex");

    if (generatedSig === signature) {
      const reg = await Registration.findOneAndUpdate(
        { orderId },
        { paymentId, status: "paid" },
        { new: true }
      );

      if (reg) {
        // Send email confirmation
        await transporter.sendMail({
          from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
          to: reg.email,
          subject: "🎉 Registration Successful - Tanuku Road Run 2025",
          html: `<h3>Hi ${reg.name},</h3><p>Thank you for registering for <b>Tanuku Road Run 2025</b> in category <b>${reg.category}</b>.</p><p>Your payment of ₹${reg.price} has been received.</p><p>We look forward to seeing you!</p>`,
        });

        // Send email to Admin
        await transporter.sendMail({
          from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
          to: ADMIN_EMAIL,
          subject: `✅ New Registration - ${reg.name}`,
          html: `<p><b>Name:</b> ${reg.name}<br><b>Email:</b> ${reg.email}<br><b>Phone:</b> ${reg.phone}<br><b>Category:</b> ${reg.category}<br><b>Amount:</b> ₹${reg.price}</p>`,
        });
      }

      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: "Invalid signature" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// Get all registrations (admin)
app.get("/api/registrations", async (req, res) => {
  try {
    const regs = await Registration.find().sort({ createdAt: -1 });
    res.json(regs);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch registrations" });
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
