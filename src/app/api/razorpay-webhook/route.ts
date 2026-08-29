import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/twilio';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();

    // --- RAZORPAY WEBHOOK SIGNATURE VERIFICATION ---
    // Without this, anyone could fake a payment and unlock escrow for free!
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers.get('x-razorpay-signature') || '';
      const expectedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSig) {
        console.error('Razorpay webhook signature mismatch');
        return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
      }
    } else {
      console.warn('[SECURITY] RAZORPAY_WEBHOOK_SECRET is not set. Skipping signature verification.');
    }

    const body = JSON.parse(rawBody);
    console.log('Razorpay webhook event:', body.event);

    const event = body.event;

    if (event === 'payment_link.paid') {
      const paymentLinkEntity = body.payload?.payment_link?.entity;
      const paymentEntity = body.payload?.payment?.entity;

      if (!paymentLinkEntity || !paymentEntity) {
        console.error('Malformed Razorpay payload:', JSON.stringify(body));
        return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
      }

      const paymentLinkId = paymentLinkEntity.id;
      const paymentId = paymentEntity.id;

      // Find contract by payment link ID
      const { data: contract, error } = await supabase
        .from('contracts')
        .select('*')
        .eq('payment_link_id', paymentLinkId)
        .single();

      if (error || !contract) {
        console.error('Contract not found for payment link:', paymentLinkId);
        // Return 200 to prevent Razorpay retries for genuinely unknown links
        return NextResponse.json({ success: true, message: 'Contract not found' });
      }

      // --- IDEMPOTENCY: Prevent double processing ---
      if (contract.payment_id) {
        console.log('Duplicate payment ignored. payment_id already set:', contract.payment_id);
        return NextResponse.json({ success: true, message: 'Already processed' });
      }

      // Contract must be in PENDING_PAYMENT to proceed
      if (contract.status !== 'PENDING_PAYMENT' && contract.status !== 'PENDING_AGREEMENT') {
        console.log('Contract not in payable state. Status:', contract.status);
        return NextResponse.json({ success: true, message: 'Not in payable state' });
      }

      // Update contract to IN_PROGRESS and save payment_id
      const { error: updateError } = await supabase
        .from('contracts')
        .update({
          status: 'IN_PROGRESS',
          payment_id: paymentId
        })
        .eq('id', contract.id);

      if (updateError) {
        console.error('Failed to update contract status:', updateError);
        return NextResponse.json({ error: 'DB update failed' }, { status: 500 });
      }

      // Log system event
      await supabase.from('events').insert({
        contract_id: contract.id,
        actor: 'system',
        type: 'payment_received',
        content: `Payment of ₹${contract.amount} received. Payment ID: ${paymentId}`
      });

      // Notify both parties
      await sendWhatsAppMessage(
        contract.freelancer_phone,
        `💰 *Payment Secured in Escrow!*\n\n₹${contract.amount.toLocaleString('en-IN')} is now safely locked for contract *#${contract.id}*.\n\nYou can now begin the work. When ready, send your work files directly in this chat.`
      );

      await sendWhatsAppMessage(
        contract.client_phone,
        `✅ *Payment Confirmed!*\n\nYour ₹${contract.amount.toLocaleString('en-IN')} is locked in escrow for contract *#${contract.id}*. The freelancer has been notified to begin work.\n\nYou'll receive updates here as work progresses.`
      );
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Razorpay Webhook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
