const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Metodo non consentito.' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Verifica del pagamento non configurata.' });
  }
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  if (!sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Sessione non valida.' });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ payment_status: session.payment_status });
  } catch (error) {
    console.error('Stripe session status error:', error.message);
    return res.status(404).json({ error: 'Sessione non trovata.' });
  }
};
