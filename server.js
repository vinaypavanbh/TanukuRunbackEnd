const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const axios = require("axios");        // ✅ NEW

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// ---------- MongoDB ----------
const MONGO_URI =
  "mongodb+srv://krishnasastry99:J12rfhtgXDzyBj2B@cluster0.zownxzc.mongodb.net/tanuku_run?retryWrites=true&w=majority";

mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connect error:", err);
    process.exit(1);
  });

// ---------- Nodemailer (Brevo) ----------
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: "957dcc001@smtp-brevo.com",
    pass: "cs7H2vEFGPKBA3wm",
  },
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
const RAZORPAY_KEY_ID = "rzp_live_R5uzxh2ODPYjrn";
const RAZORPAY_KEY_SECRET = "dRVP063bPmjvKQi3wZPiR9T7";

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ---------- Interakt Config (WhatsApp) ----------
const INTERAKT_API_KEY = "NVpWZzRKYzFuRzBuLS1sSjRPc1A3bzNjVEs4LXlnNk9OVjRWTkxDdGdpYzo="; // 🔒 set env variable in production
const INTERAKT_URL = "https://api.interakt.ai/v1/public/message";

// ---------- Price mapping ----------
const priceMappingRupees = { "3K": 250, "5K": 300, "10K": 350 };

// ---------- Routes ----------

// Health check
app.get("/api/health", (_, res) => res.json({ ok: true }));

// Create order
app.post("/api/create-order", async (req, res) => {
  try {
    const {
      raceType,
      name,
      email,
      phone,
      age,
      gender,
      city,
      bloodGroup,
      tshirtSize,
    } = req.body;

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

// Complete registration / payment
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

    const pending = await PendingOrder.findOne({ orderId });
    if (!pending)
      return res.status(400).json({ success: false, error: "Pending order not found" });

    const generatedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (generatedSignature !== signature) {
      return res.status(400).json({ success: false, error: "Invalid signature." });
    }

    const payment = await razorpay.payments.fetch(paymentId).catch(() => null);
    if (!payment || payment.status !== "captured") {
      return res.status(400).json({ success: false, error: "Payment not captured." });
    }

    // Save registration
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
      amount: pending.amount,
      paymentId,
      orderId,
      signature,
    });
    await reg.save();

    await PendingOrder.deleteOne({ orderId });

    // --- Send Email ---
    const mailOptions = {
      from: '"Tanuku Road Run 2025" <tanukuroadrun@gmail.com>',
      to: email,
      subject: `Registration Successful - ${runType}`,
      html: `
        <h2>Thank you for registering, ${name}!</h2>
        <p>Your registration for <strong>${runType}</strong> has been confirmed.</p>
        <p><strong>Amount Paid:</strong> ₹${pending.amount / 100}</p>
        <p>We look forward to seeing you at Tanuku Road Run 2025!</p>
        <br/>
        <p>Regards,<br/>Tanuku Road Runner Team</p>
      `,
    };
    transporter.sendMail(mailOptions, (err) => {
      if (err) console.error("Email sending failed:", err);
    });

    // --- ✅ Send WhatsApp template via Interakt ---
    try {
      await axios.post(
        INTERAKT_URL,
        {
          from: "+919629050142", // your Interakt sender number
          fullPhoneNumber: `+91${phone}`,
          type: "Template",
          template: {
            name: "event_registration_confirmation_ue",
            languageCode: "en",
            bodyValues: [
              "07 December 2025", // Event Date
              "Tanuku, Andhra Pradesh", // Location
            ],
          },
        },
        {
          headers: {
            Authorization: `Basic ${INTERAKT_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`✅ WhatsApp message sent to ${phone}`);
    } catch (waErr) {
      console.error("❌ WhatsApp send error:", waErr.response?.data || waErr.message);
    }

    res.json({ success: true, id: reg._id });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// List registrations
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
