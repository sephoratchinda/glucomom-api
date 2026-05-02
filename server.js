const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY         = process.env.GROQ_API_KEY         || '';
const SUPABASE_URL         = process.env.SUPABASE_URL         || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

console.log('GlucoMom API starting...');
console.log('GROQ_API_KEY set:', !!GROQ_API_KEY);
console.log('SUPABASE_URL set:', !!SUPABASE_URL);
console.log('SUPABASE_SERVICE_KEY set:', !!SUPABASE_SERVICE_KEY);

// ── Groq AI (free) ────────────────────────────────────────────────────────────
async function askGroq(system, user) {
  if (!GROQ_API_KEY) return 'Service IA non configuré.';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + GROQ_API_KEY,
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 500,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'Je ne peux pas répondre.';
}

// ── Supabase (lazy — only created when needed) ────────────────────────────────
function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  // Import and create inside function so it never runs at startup
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'GlucoMom API' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { question = '', currentGlucose, currentGlucoseContext,
            waterToday = 0, medsInfo = '', recentFoods = '' } = req.body;

    if (!question.trim()) return res.json({ answer: 'Question vide.' });

    const system =
      'Tu es un conseiller diététique diabète. Parle directement à la patiente (tu/toi/ton/ta). ' +
      'Elle est camerounaise. ' +
      'Glycémie: ' + (currentGlucose ? currentGlucose + ' mg/dL (' + (currentGlucoseContext || '') + ')' : 'non mesurée') + '. ' +
      'Médicaments: ' + (medsInfo || 'non renseignés') + '. ' +
      'Eau: ' + waterToday + 'L. ' +
      'Aliments récents: ' + (recentFoods || 'aucun') + '. ' +
      'Réponds en français, chaleureux, max 120 mots. Aliments camerounais (ndolé, eru, plantain, fufu, macabo).';

    const answer = await askGroq(system, question);
    res.json({ answer });
  } catch (e) {
    console.error('/api/chat error:', e.message);
    res.json({ answer: 'Service IA temporairement indisponible.' });
  }
});

app.post('/api/predict', async (req, res) => {
  try {
    const { readings = [], missedDoses = 0, totalDoses = 0,
            waterToday = 0, recentFoods = '' } = req.body;

    const readingsText = readings.length
      ? readings.map(r => r.value_mgdl + ' mg/dL à ' + r.reading_time).join(' → ')
      : 'aucune mesure';

    const system =
      'Tu es médecin diabétologue. Parle directement à la patiente (tu/toi). ' +
      'Camerounaise, diabétique. Max 180 mots en français. ' +
      'Structure: 1)📊 Glycémie  2)⚠️ Risques  3)🔮 Prévision  4)✅ Actions maintenant';

    const userMsg =
      'Glycémies: ' + readingsText + '\n' +
      'Doses manquées: ' + missedDoses + '/' + totalDoses + '\n' +
      'Eau: ' + waterToday + 'L\n' +
      'Aliments: ' + (recentFoods || 'aucun');

    const analysis = await askGroq(system, userMsg);
    res.json({ analysis });
  } catch (e) {
    console.error('/api/predict error:', e.message);
    res.json({ analysis: '' });
  }
});

app.get('/api/shared/:token', async (req, res) => {
  try {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: 'Database not configured' });

    const { data: profile } = await sb
      .from('profiles')
      .select('id, full_name')
      .eq('share_token', req.params.token)
      .single();

    if (!profile) return res.status(404).json({ error: 'Token invalide' });

    const today   = new Date().toISOString().split('T')[0];
    const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    const [g, m, w] = await Promise.all([
      sb.from('glucose_readings').select('*').eq('user_id', profile.id).gte('reading_date', sevenAgo),
      sb.from('meals').select('*, meal_foods(*)').eq('user_id', profile.id).eq('meal_date', today),
      sb.from('water_logs').select('*').eq('user_id', profile.id).eq('log_date', today),
    ]);

    res.json({ name: profile.full_name, glucose: g.data || [], meals: m.data || [], water: w.data || [] });
  } catch (e) {
    console.error('/api/shared error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log('GlucoMom API running on port ' + PORT));
