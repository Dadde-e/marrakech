const Stripe = require('stripe');

const CATALOGO = {
  1: { nome: 'Portacandele Tadelakt', prezzo: 3990 },
  2: { nome: 'Candeliere Berbero Tadelakt', prezzo: 5900 },
  3: { nome: 'Candeliere Tadelakt Nero', prezzo: 4550 },
  4: { nome: 'Vaso Scultoreo Circle', prezzo: 2800 }
};
const SPEDIZIONE_CENTESIMI = 790;

function testo(v, max = 400) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo non consentito.' });
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.BASE_URL) {
    return res.status(503).json({ error: 'Il pagamento non è ancora configurato.' });
  }

  const body = req.body || {};
  const nome = testo(body.nome, 200);
  const email = testo(body.email, 254);
  const telefono = testo(body.telefono, 100);
  const citta = testo(body.citta, 200);
  const indirizzo = testo(body.indirizzo, 400);
  const note = testo(body.note, 400);
  const articoli = body.articoli;

  if (!nome || !/^\S+@\S+\.\S+$/.test(email) || !telefono || !citta || !indirizzo) {
    return res.status(400).json({ error: 'Controlla i dati obbligatori del cliente.' });
  }
  if (!Array.isArray(articoli) || articoli.length < 1 || articoli.length > 4) {
    return res.status(400).json({ error: 'Carrello non valido.' });
  }

  const ids = new Set();
  const line_items = [];
  for (const item of articoli) {
    const id = Number(item && item.id);
    const quantita = Number(item && item.quantita);
    const prodotto = CATALOGO[id];
    if (!prodotto || ids.has(id) || !Number.isInteger(quantita) || quantita < 1 || quantita > 2) {
      return res.status(400).json({ error: 'Carrello non valido: massimo 2 pezzi per prodotto.' });
    }
    ids.add(id);
    line_items.push({
      quantity: quantita,
      price_data: {
        currency: 'eur',
        unit_amount: prodotto.prezzo,
        product_data: { name: prodotto.nome }
      }
    });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      customer_email: email,
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['IT'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: SPEDIZIONE_CENTESIMI, currency: 'eur' },
          display_name: 'Spedizione in Italia',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 3 },
            maximum: { unit: 'business_day', value: 5 }
          }
        }
      }],
      metadata: {
        customer_name: nome,
        customer_phone: telefono,
        customer_city: citta,
        customer_address: indirizzo,
        customer_notes: note
      },
      success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}#grazie`,
      cancel_url: `${baseUrl}/#prodotti`
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe Checkout error:', error.message);
    return res.status(500).json({ error: 'Non è stato possibile avviare il pagamento. Riprova.' });
  }
};
