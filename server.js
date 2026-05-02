const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Groq AI call (free) ───────────────────────────────────────────────────────
async function askGroq(systemPrompt, userMessage) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',   // free model on Groq
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
    }),
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'Je ne peux pas répondre pour le moment.';
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'GlucoMom API', time: new Date().toISOString() });
});

// ── AI CHATBOT ────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const {
    question,
    currentGlucose,
    currentGlucoseContext,
    waterToday,
    medsInfo,
    recentFoods,
  } = req.body;

  if (!question) return res.status(400).json({ error: 'question required' });

  const system = `Tu es un conseiller diététique spécialisé en diabète.
Tu parles DIRECTEMENT à la patiente — utilise "tu", "toi", "ton", "ta". Jamais "elle" ou "lui".
Elle est camerounaise et diabétique.
Glycémie actuelle: ${currentGlucose ? currentGlucose + ' mg/dL (' + currentGlucoseContext + ')' : 'non mesurée'}.
Médicaments: ${medsInfo || 'non renseignés'}.
Eau aujourd'hui: ${waterToday ? waterToday + 'L' : 'non renseignée'}.
Aliments récents: ${recentFoods || 'aucun'}.
Réponds en français. Sois chaleureux, direct. Max 120 mots.
Cite des aliments camerounais si possible (ndolé, eru, plantain, fufu, koki, macabo).`;

  try {
    const answer = await askGroq(system, question);
    res.json({ answer });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ answer: 'Service IA temporairement indisponible.' });
  }
});

// ── AI PREDICTION ─────────────────────────────────────────────────────────────
app.post('/api/predict', async (req, res) => {
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
    .map(r => `${r.value_mgdl} mg/dL à ${r.reading_time} (${r.context})`)
    .join(' → ');

  const system = `Tu es un médecin diabétologue.
Tu parles DIRECTEMENT à la patiente — utilise "tu", "toi", "ton", "ta". Jamais "elle" ou "lui".
Elle est camerounaise et diabétique.
Analyse structurée en français. Max 180 mots.
Structure obligatoire:
1) 📊 Ta glycémie aujourd'hui
2) ⚠️ Facteurs de risque identifiés
3) 🔮 Ce qui pourrait se passer dans les prochaines heures
4) ✅ Ce que tu dois faire maintenant (aliments camerounais, médicaments, eau)`;

  const userMsg = `DONNÉES:
Glycémies: ${readingsText || 'aucune mesure'}
Médicaments manqués: ${missedDoses}/${totalDoses}
Eau: ${waterToday}L
Aliments récents: ${recentFoods || 'aucun'}
Prédiction hypoglycémie: ${hypoEta || 'aucune dans 6h'}
Prédiction hyperglycémie: ${hyperEta || 'aucune dans 6h'}`;

  try {
    const analysis = await askGroq(system, userMsg);
    res.json({ analysis });
  } catch (err) {
    console.error('Predict error:', err);
    res.status(500).json({ analysis: '' });
  }
});

// ── SHARED ACCESS — read-only for doctor/family ───────────────────────────────
app.get('/api/shared/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, share_token')
      .eq('share_token', token)
      .single();

    if (!profile) return res.status(404).json({ error: 'Token invalide' });

    const today = new Date().toISOString().split('T')[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    const [glucoseRes, mealsRes, waterRes] = await Promise.all([
      supabase.from('glucose_readings').select('*')
        .eq('user_id', profile.id)
        .gte('reading_date', sevenDaysAgo)
        .order('reading_date', { ascending: false }),
      supabase.from('meals').select('*, meal_foods(*)')
        .eq('user_id', profile.id).eq('meal_date', today),
      supabase.from('water_logs').select('*')
        .eq('user_id', profile.id).eq('log_date', today),
    ]);

    res.json({
      name: profile.full_name,
      glucose: glucoseRes.data || [],
      meals: mealsRes.data || [],
      water: waterRes.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GlucoMom API running on port ${PORT}`));
