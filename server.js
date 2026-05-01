const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // service_role key — has full access
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Firebase Admin (for push notifications)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT),
    ),
  });
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", app: "GlucoMom API" }),
);

// ── AI CHATBOT ────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const {
    question,
    currentGlucose,
    currentGlucoseContext,
    waterToday,
    medsInfo,
    recentFoods,
  } = req.body;

  if (!question) return res.status(400).json({ error: "question required" });

  const systemPrompt = `Tu es un conseiller diététique spécialisé en diabète. 
Tu parles DIRECTEMENT à la patiente (utilise "tu", "toi", "ton", "ta" — jamais "elle" ou "lui").
Elle est camerounaise et diabétique.
Sa glycémie actuelle: ${currentGlucose ? currentGlucose + " mg/dL (" + currentGlucoseContext + ")" : "non mesurée"}.
Médicaments: ${medsInfo || "non renseignés"}.
Eau aujourd'hui: ${waterToday ? waterToday + "L" : "non renseignée"}.
Aliments récents: ${recentFoods || "aucun"}.
Réponds en français, chaleureux, direct, max 150 mots.
Utilise des aliments camerounais (ndolé, eru, plantain, fufu, koki, macabo, etc.).`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: question }],
    });
    res.json({ answer: message.content[0].text });
  } catch (err) {
    console.error("AI chat error:", err);
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── AI PREDICTION ANALYSIS ────────────────────────────────────────────────────
app.post("/api/predict", async (req, res) => {
  const {
    readings,
    missedDoses,
    totalDoses,
    waterToday,
    recentFoods,
    hypoEta,
    hyperEta,
  } = req.body;

  const readingsText = (readings || [])
    .map((r) => `${r.value_mgdl} mg/dL à ${r.reading_time} (${r.context})`)
    .join(" → ");

  const systemPrompt = `Tu es un médecin diabétologue. 
Tu parles DIRECTEMENT à la patiente (utilise "tu", "toi", "ton", "ta" — jamais "elle" ou "lui").
Elle est camerounaise, diabétique.
Produis une analyse structurée en français, bienveillante et actionnelle. Max 200 mots.
Structure: 
1) 📊 Ta glycémie aujourd'hui
2) ⚠️ Facteurs de risque identifiés  
3) 🔮 Ce qui pourrait se passer dans les prochaines heures
4) ✅ Ce que tu dois faire maintenant (aliments camerounais, médicaments, hydratation)`;

  const userContent = `DONNÉES:
Glycémies: ${readingsText || "aucune mesure"}
Médicaments manqués: ${missedDoses}/${totalDoses}
Eau: ${waterToday}L
Aliments récents: ${recentFoods || "aucun"}
Prédiction hypoglycémie: ${hypoEta || "aucune dans 6h"}
Prédiction hyperglycémie: ${hyperEta || "aucune dans 6h"}
Produis l'analyse complète.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    res.json({ analysis: message.content[0].text });
  } catch (err) {
    console.error("Prediction error:", err);
    res.status(500).json({ error: "AI unavailable" });
  }
});

// ── PUSH NOTIFICATION (called by a cron or trigger) ───────────────────────────
app.post("/api/notify", async (req, res) => {
  const { fcmToken, title, body } = req.body;
  if (!fcmToken) return res.status(400).json({ error: "fcmToken required" });

  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    res.json({ sent: true });
  } catch (err) {
    console.error("FCM error:", err);
    res.status(500).json({ error: "Notification failed" });
  }
});

// ── APPOINTMENT REMINDER CHECK (call this via Railway cron daily at 8am) ─────
app.post("/api/check-appointments", async (req, res) => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  try {
    // Get all appointments for tomorrow that haven't been notified
    const { data: appts } = await supabase
      .from("appointments")
      .select("*, profiles(full_name)")
      .eq("appointment_date", tomorrowStr)
      .eq("notification_sent", false);

    let sent = 0;
    for (const appt of appts || []) {
      // Get user's FCM token (you'd store this in profiles table)
      const { data: profile } = await supabase
        .from("profiles")
        .select("fcm_token")
        .eq("id", appt.user_id)
        .single();

      if (profile?.fcm_token) {
        await admin.messaging().send({
          token: profile.fcm_token,
          notification: {
            title: "🏥 RDV médical demain!",
            body: `Dr ${appt.doctor_name} — ${appt.hospital || ""} à ${appt.appointment_time || ""}`,
          },
        });
        // Mark as notified
        await supabase
          .from("appointments")
          .update({ notification_sent: true })
          .eq("id", appt.id);
        sent++;
      }
    }
    res.json({ sent });
  } catch (err) {
    console.error("Appointment check error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── SHARED ACCESS — read-only data for doctor/family ─────────────────────────
app.get("/api/shared/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, full_name, share_token")
      .eq("share_token", token)
      .single();

    if (!profile) return res.status(404).json({ error: "Token invalide" });

    const today = new Date().toISOString().split("T")[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)
      .toISOString()
      .split("T")[0];

    const [glucoseRes, mealsRes, waterRes] = await Promise.all([
      supabase
        .from("glucose_readings")
        .select("*")
        .eq("user_id", profile.id)
        .gte("reading_date", sevenDaysAgo)
        .order("reading_date", { ascending: false })
        .order("reading_time", { ascending: false }),
      supabase
        .from("meals")
        .select("*, meal_foods(*)")
        .eq("user_id", profile.id)
        .eq("meal_date", today),
      supabase
        .from("water_logs")
        .select("*")
        .eq("user_id", profile.id)
        .eq("log_date", today),
    ]);

    res.json({
      name: profile.full_name,
      glucose: glucoseRes.data,
      meals: mealsRes.data,
      water: waterRes.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GlucoMom API running on port ${PORT}`));
