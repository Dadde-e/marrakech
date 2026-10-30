const Stripe = require('stripe');

// Vercel deve consegnare il body originale: serve per verificare la firma Stripe.
module.exports.config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

async function inviaEmail({ to, subject, html, text, idempotencyKey }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [to],
      reply_to: process.env.STORE_EMAIL || undefined,
      subject,
      html,
      text
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL || !process.env.STORE_EMAIL) {
    return res.status(503).send('Webhook non configurato.');
  }

  let event;
  try {
    const body = await rawBody(req);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe webhook signature error:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
    if (session.payment_status !== 'paid') return res.status(200).json({ received: true, payment_pending: true });

    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    const details = lineItems.data.map(item => `${item.quantity} × ${item.description} — €${(item.amount_total / 100).toFixed(2)}`).join('\n');
    const shipping = session.shipping_details || {};
    const address = shipping.address || {};
    const fullAddress = [address.line1, address.line2].filter(Boolean).join(', ');
    const city = [address.postal_code, address.city, address.state].filter(Boolean).join(' ');
    const customerName = shipping.name || session.metadata.customer_name || 'Cliente';
    const customerEmail = (session.customer_details && session.customer_details.email) || session.customer_email;
    const customerPhone = (session.customer_details && session.customer_details.phone) || session.metadata.customer_phone || '';
    const total = (session.amount_total / 100).toFixed(2);
    const shippingCost = (session.total_details && session.total_details.amount_shipping != null)
      ? (session.total_details.amount_shipping / 100).toFixed(2) : '7.90';
    if (!customerEmail) throw new Error('Email cliente non presente nella sessione Stripe.');

    const safeName = escapeHtml(customerName);
    const safeItems = escapeHtml(details).replace(/\n/g, '<br>');
    const safeAddress = escapeHtml(fullAddress);
    const safeCity = escapeHtml(city);
    const safePhone = escapeHtml(customerPhone);
    const safeNotes = escapeHtml(session.metadata.customer_notes || 'Nessuna nota');
    const common = `<p>Pagamento verificato da Stripe.</p><p><strong>Ordine:</strong><br>${safeItems}</p><p><strong>Spedizione:</strong> €${shippingCost}<br><strong>Totale pagato:</strong> €${total}</p><p><strong>Destinatario:</strong> ${safeName}<br><strong>Indirizzo:</strong> ${safeAddress}, ${safeCity}<br><strong>Telefono:</strong> ${safePhone}</p>`;

    await inviaEmail({
      to: customerEmail,
      subject: 'SOUK MARRAKECH – Conferma del tuo ordine',
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#28231f"><h2>Grazie per il tuo ordine, ${safeName}!</h2><p>Il pagamento è stato ricevuto correttamente. Ecco il riepilogo del tuo acquisto:</p>${common}<p>Grazie per aver scelto SOUK MARRAKECH.</p></div>`,
      text: `Grazie per il tuo ordine, ${customerName}!\nPagamento verificato.\n${details}\nSpedizione: €${shippingCost}\nTotale pagato: €${total}\nIndirizzo: ${fullAddress}, ${city}\nTelefono: ${customerPhone}`,
      idempotencyKey: `souk-order-${session.id}-customer`
    });

    await inviaEmail({
      to: process.env.STORE_EMAIL,
      subject: `Nuovo ordine pagato – SOUK MARRAKECH (${session.id})`,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#28231f"><h2>Nuovo ordine pagato</h2>${common}<p><strong>Note cliente:</strong> ${safeNotes}</p><p><strong>Email cliente:</strong> ${escapeHtml(customerEmail)}</p><p><strong>ID sessione Stripe:</strong> ${escapeHtml(session.id)}</p></div>`,
      text: `Nuovo ordine pagato\nCliente: ${customerName}\nEmail: ${customerEmail}\nTelefono: ${customerPhone}\nArticoli:\n${details}\nSpedizione: €${shippingCost}\nTotale: €${total}\nIndirizzo: ${fullAddress}, ${city}\nNote: ${session.metadata.customer_notes || 'Nessuna nota'}\nSessione: ${session.id}`,
      idempotencyKey: `souk-order-${session.id}-store`
    });

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Errore invio email ordine:', error.message);
    // 500 fa sì che Stripe riprovi la consegna del webhook.
    return res.status(500).json({ error: 'Notifica ordine non inviata.' });
  }
};
