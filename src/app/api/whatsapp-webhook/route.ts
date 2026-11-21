import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendWhatsAppMessage } from '@/lib/greenApi';
import { adjudicateDispute } from '@/lib/judge';

// =========================================================
// HELPER: Execute Payout to Freelancer
// =========================================================
async function executePayoutToFreelancer(contract: any, freelancerAmount: number): Promise<boolean> {
  try {
    const razorpayAny: any = (await import('@/lib/razorpay')).razorpay;
    if (!razorpayAny) {
      console.warn('Razorpay not configured. Skipping payout.');
      return false;
    }

    const { data: fUser } = await supabase
      .from('users')
      .select('upi_id, name')
      .eq('phone', contract.freelancer_phone)
      .single();

    if (!fUser?.upi_id) {
      console.error('Freelancer has no UPI ID.');
      return false;
    }

    const contact = await razorpayAny.contacts.create({
      name: fUser.name || 'Freelancer',
      contact: contract.freelancer_phone
    });
    const fundAccount = await razorpayAny.fundAccount.create({
      contact_id: contact.id,
      account_type: 'vpa',
      vpa: { address: fUser.upi_id }
    });
    await razorpayAny.payouts.create({
      account_number: process.env.RAZORPAY_ACCOUNT_NUMBER || '',
      fund_account_id: fundAccount.id,
      amount: freelancerAmount * 100,
      currency: 'INR',
      mode: 'UPI',
      purpose: 'freelancer_payment',
      narration: `Arbiter payment — ${contract.id}`
    });
    return true;
  } catch (e) {
    console.error('Payout error:', e);
    return false;
  }
}

// =========================================================
// HELPER: Execute Refund to Client
// =========================================================
async function executeRefundToClient(contract: any, refundAmount: number): Promise<boolean> {
  try {
    if (!contract.payment_id) {
      console.warn('No payment_id on contract — cannot refund.');
      return false;
    }
    const razorpayAny: any = (await import('@/lib/razorpay')).razorpay;
    if (!razorpayAny) return false;
    await razorpayAny.payments.refund(contract.payment_id, { amount: refundAmount * 100 });
    return true;
  } catch (e) {
    console.error('Refund error:', e);
    return false;
  }
}

// =========================================================
// HELPER: Handle Full Approval (full payout to freelancer)
// =========================================================
async function handleApproval(contract: any) {
  const success = await executePayoutToFreelancer(contract, contract.amount);
  await supabase.from('events').insert({
    contract_id: contract.id,
    actor: 'CLIENT',
    type: 'approved',
    content: 'Client approved and payment was released.'
  });

  if (success) {
    await supabase.from('contracts').update({ status: 'COMPLETED' }).eq('id', contract.id);
    await sendWhatsAppMessage(
      contract.freelancer_phone,
      `🎉 *Work Approved!*\n\n₹${contract.amount.toLocaleString('en-IN')} is being sent to your UPI.\nContract *#${contract.id}* is complete! ✅`
    );
    await sendWhatsAppMessage(
      contract.client_phone,
      `✅ Payment released to the freelancer. Contract *#${contract.id}* is complete!`
    );
  } else {
    await supabase.from('contracts').update({ status: 'PAYOUT_PENDING' }).eq('id', contract.id);
    await sendWhatsAppMessage(
      contract.freelancer_phone,
      `⚠️ Work approved, but payout failed. Please check your UPI ID by typing *#arbiter EDIT UPI* and we will retry.`
    );
    await sendWhatsAppMessage(
      contract.client_phone,
      `✅ You approved the work. We are processing the payment to the freelancer.`
    );
  }
}

// =========================================================
// HELPER: Handle Split Payout (negotiate or dispute)
// =========================================================
async function executeSplitPayout(contract: any, freelancerAmount: number) {
  const clientRefund = contract.amount - freelancerAmount;

  const payoutOk = freelancerAmount > 0
    ? await executePayoutToFreelancer(contract, freelancerAmount)
    : true;
  const refundOk = clientRefund > 0
    ? await executeRefundToClient(contract, clientRefund)
    : true;

  if (payoutOk && refundOk) {
    await supabase.from('contracts').update({ status: 'COMPLETED', active_negotiation_amount: null }).eq('id', contract.id);
    await sendWhatsAppMessage(
      contract.freelancer_phone,
      `✅ Settlement complete! ₹${freelancerAmount.toLocaleString('en-IN')} is being sent to your UPI.`
    );
    await sendWhatsAppMessage(
      contract.client_phone,
      `✅ Settlement complete! ₹${clientRefund.toLocaleString('en-IN')} refund is on its way.`
    );
  } else {
    await supabase.from('contracts').update({ status: 'PAYOUT_PENDING' }).eq('id', contract.id);
    await sendWhatsAppMessage(
      contract.freelancer_phone,
      `⚠️ Settlement payout encountered an issue. Contact support. Contract *#${contract.id}*.`
    );
    await sendWhatsAppMessage(
      contract.client_phone,
      `⚠️ Settlement refund encountered an issue. Contact support. Contract *#${contract.id}*.`
    );
  }
}

// =========================================================
// HELPER: Run Dispute and Notify Both Parties
// =========================================================
async function runDisputeAndNotify(contract: any) {
  try {
    await sendWhatsAppMessage(
      contract.freelancer_phone,
      `🧑‍⚖️ Both statements received. The AI Judge is reviewing all evidence for contract *#${contract.id}*...`
    );
    await sendWhatsAppMessage(
      contract.client_phone,
      `🧑‍⚖️ Both statements received. The AI Judge is reviewing all evidence for contract *#${contract.id}*...`
    );

    const ruling = await adjudicateDispute(contract.id);

    await supabase.from('events').insert({
      contract_id: contract.id,
      actor: 'ai',
      type: 'ruling',
      content: JSON.stringify(ruling)
    });

    await executeSplitPayout(contract, ruling.freelancer_amount);

    const rulingMsg =
      `🧑‍⚖️ *AI JUDGE RULING — #${contract.id}*\n` +
      `─────────────────────────\n` +
      `*Summary:* ${ruling.ruling_summary}\n\n` +
      `*Verdict:*\n` +
      `✅ Freelancer receives: ₹${ruling.freelancer_amount.toLocaleString('en-IN')} (${ruling.freelancerSplit}%)\n` +
      `🔄 Client refund: ₹${ruling.client_refund.toLocaleString('en-IN')} (${ruling.clientSplit}%)\n\n` +
      `*Reasoning:* ${ruling.reasoning}\n` +
      `─────────────────────────\n` +
      `*Key Evidence:* ${ruling.key_evidence}`;

    await sendWhatsAppMessage(contract.freelancer_phone, rulingMsg);
    await sendWhatsAppMessage(contract.client_phone, rulingMsg);

  } catch (e) {
    console.error('Dispute adjudication error:', e);
    const half = Math.floor(contract.amount / 2);
    await executeSplitPayout(contract, half);
    const fallbackMsg = `⚠️ The AI Judge encountered an error. A 50/50 split has been applied as a neutral fallback for contract *#${contract.id}*.`;
    await sendWhatsAppMessage(contract.freelancer_phone, fallbackMsg);
    await sendWhatsAppMessage(contract.client_phone, fallbackMsg);
  }
}

// =========================================================
// HELPER: Send contract card to client for review
// =========================================================
async function sendContractCardToClient(contract: any, freelancerName: string) {
  const clientName = contract.client_name || 'Client';
  const contractCard =
    `📋 *ARB CONTRACT #${contract.id}*\n` +
    `─────────────────────────\n` +
    `*Work:* ${contract.description}\n` +
    `*Revisions:* ${contract.revisions_allowed}\n` +
    `*Payment:* ₹${contract.amount.toLocaleString('en-IN')} (held in escrow until you approve)\n` +
    `─────────────────────────\n` +
    `*Freelancer:* ${freelancerName}\n` +
    `*Freelancer Phone:* +${contract.freelancer_phone}\n` +
    `*Client:* ${clientName}\n` +
    `─────────────────────────\n` +
    `This contract is binding once payment is made.\n\n` +
    `Reply *AGREE* to pay and start, or *EDIT* to request changes.`;

  await sendWhatsAppMessage(contract.client_phone, contractCard);
}

// =========================================================
// MAIN WEBHOOK HANDLER (Green API + Twilio compatible)
// =========================================================
export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    let phone = '';
    let body = '';
    let messageSid = '';
    let mediaUrl: string | null = null;

    // Check if JSON (Green API webhook format)
    if (rawBody.trim().startsWith('{')) {
      const data = JSON.parse(rawBody);
      const typeWebhook = data.typeWebhook;

      if (typeWebhook !== 'incomingMessageReceived') {
        return NextResponse.json({ success: true, ignored: true });
      }

      const senderData = data.senderData || {};
      const messageData = data.messageData || {};

      const sender = senderData.chatId || senderData.sender || '';
      phone = sender.replace('@c.us', '').replace('whatsapp:', '');
      messageSid = data.idMessage || '';

      if (messageData.typeMessage === 'textMessage') {
        body = messageData.textMessageData?.textMessage || '';
      } else if (messageData.typeMessage === 'extendedTextMessage') {
        body = messageData.extendedTextMessageData?.text || '';
      } else if (messageData.typeMessage === 'fileMessage') {
        body = messageData.fileMessageData?.caption || '';
        mediaUrl = messageData.fileMessageData?.downloadUrl || null;
      }
    } else {
      const params = new URLSearchParams(rawBody);
      const from = params.get('From') || '';
      body = params.get('Body') || '';
      messageSid = params.get('MessageSid') || '';
      mediaUrl = params.get('MediaUrl0');
      phone = from.replace('whatsapp:', '').replace(/\D/g, '');
    }

    if (!phone) return NextResponse.json({ error: 'Missing phone/sender' }, { status: 400 });

    // =========================================================
    // #ARBITER TRIGGER FILTER
    // =========================================================
    const cleanBody = body.trim();
    const hasTrigger = cleanBody.toLowerCase().includes('#arbiter');

    // Check if user exists
    let { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();

    const isOngoingFlow = user && user.state && user.state !== 'IDLE';

    // Check for active contracts involving this phone
    const { data: hasActiveContract } = await supabase
      .from('contracts')
      .select('id')
      .or(`freelancer_phone.eq.${phone},client_phone.eq.${phone}`)
      .in('status', ['PENDING_AGREEMENT', 'IN_PROGRESS', 'DISPUTED'])
      .limit(1);

    const isInActiveContract = hasActiveContract && hasActiveContract.length > 0;

    if (!hasTrigger && !isOngoingFlow && !isInActiveContract) {
      console.log(`[IGNORE] Personal message without #arbiter trigger from ${phone}`);
      return NextResponse.json({ success: true, ignored: true });
    }

    // Strip #arbiter trigger
    let processedBody = cleanBody.replace(/#arbiter/gi, '').trim();
    if (!processedBody && hasTrigger) {
      processedBody = 'MENU';
    }

    // --- IDEMPOTENCY ---
    if (messageSid) {
      const { data: existingMsg } = await supabase
        .from('processed_messages')
        .select('message_sid')
        .eq('message_sid', messageSid)
        .single();

      if (existingMsg) {
        console.log(`Duplicate message ${messageSid} ignored.`);
        return NextResponse.json({ success: true });
      }

      await supabase.from('processed_messages').insert({ message_sid: messageSid });
    }

    // =========================================================
    // FIX #4: NEW USER WITH PENDING CONTRACT → auto-register
    // If a client is new but already has a contract waiting, register
    // them silently and proceed to the contract flow instead of
    // forcing onboarding (which would swallow the AGREE command).
    // =========================================================
    const isNewUser = !user && (userError as any)?.code === 'PGRST116';

    if (isNewUser) {
      // Check if this phone is a client on a pending contract
      const { data: pendingForNewClient } = await supabase
        .from('contracts')
        .select('id, client_name')
        .eq('client_phone', phone)
        .eq('status', 'PENDING_AGREEMENT')
        .limit(1);

      if (pendingForNewClient && pendingForNewClient.length > 0) {
        // Auto-register client with name from contract (freelancer already provided it)
        const clientName = pendingForNewClient[0].client_name || 'Client';
        await supabase.from('users').insert({ phone, name: clientName, state: 'IDLE' });
        // Re-fetch user so the rest of the handler works
        const { data: refetched } = await supabase.from('users').select('*').eq('phone', phone).single();
        user = refetched;
        userError = null;
      } else {
        // FIX #1: Normal new user onboarding (freelancer first time)
        await supabase.from('users').insert({ phone, state: 'SETUP_NAME' });
        await sendWhatsAppMessage(
          phone,
          `👋 *Welcome to Arbiter* ⚖️\n\nThe safest way to handle freelance contracts on WhatsApp.\n\nTo get started, what is your full name?`
        );
        return NextResponse.json({ success: true });
      }
    }

    if (!user) {
      console.error('Unexpected Supabase error fetching user:', userError);
      return NextResponse.json({ error: 'User fetch failed' }, { status: 500 });
    }

    const command = processedBody.toUpperCase();

    // =========================================================
    // GLOBAL COMMANDS
    // =========================================================
    if (command === 'RESET') {
      await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
      await sendWhatsAppMessage(phone, `🔄 Your session has been reset. Type *#arbiter MENU* to see your options.`);
      return NextResponse.json({ success: true });
    }

    if (command === 'EDIT UPI') {
      await supabase.from('users').update({ state: 'SETUP_UPI' }).eq('phone', phone);
      await sendWhatsAppMessage(phone, `Please reply with your new UPI ID.\n\nExample: *ashutosh@ybl*`);
      return NextResponse.json({ success: true });
    }

    if (command === 'MENU') {
      await supabase.from('users').update({ state: 'IDLE' }).eq('phone', phone);
    }

    // =========================================================
    // MULTI-STEP STATE FLOWS
    // =========================================================

    // STATE: AWAITING_FEEDBACK — client describing revision changes
    if (user.state === 'AWAITING_FEEDBACK') {
      const stateData = user.state_data || {};
      const { data: contract } = await supabase
        .from('contracts')
        .select('*')
        .eq('id', stateData.contractId)
        .single();

      if (!contract) {
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
        await sendWhatsAppMessage(phone, `Something went wrong. Type RESET to start over.`);
        return NextResponse.json({ success: true });
      }

      if (processedBody.length < 10) {
        await sendWhatsAppMessage(phone, `Please describe the changes in at least 10 characters so the freelancer can understand what to fix.`);
        return NextResponse.json({ success: true });
      }

      const feedback = processedBody;
      const revisionsUsed = contract.client_revision_count + 1;
      const revisionsLeft = contract.revisions_allowed - revisionsUsed;

      await supabase.from('events').insert({
        contract_id: contract.id,
        actor: 'CLIENT',
        type: 'revision_requested',
        content: feedback
      });

      await supabase.from('contracts').update({
        submission_status: 'AWAITING_FREELANCER_SUBMISSION',
        client_revision_count: revisionsUsed
      }).eq('id', contract.id);

      await sendWhatsAppMessage(
        contract.freelancer_phone,
        `🔄 *CONTRACT #${contract.id} — REVISION REQUEST*\n` +
        `─────────────────────────\n` +
        `Revisions used: ${revisionsUsed} of ${contract.revisions_allowed}\n\n` +
        `*Client feedback:*\n"${feedback}"\n` +
        `─────────────────────────\n` +
        `When your updated work is ready, send the file here.`
      );
      await sendWhatsAppMessage(
        phone,
        `✅ Revision request sent to the freelancer.\n\n${revisionsLeft > 0 ? `You have ${revisionsLeft} revision${revisionsLeft !== 1 ? 's' : ''} remaining.` : `⚠️ This was your last revision round.`}`
      );

      await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
      return NextResponse.json({ success: true });
    }

    // =========================================================
    // FIX #3: AWAITING_CONTRACT_EDIT → collect client feedback,
    // then put FREELANCER into edit wizard for the same contract
    // =========================================================
    if (user.state === 'AWAITING_CONTRACT_EDIT') {
      const stateData = user.state_data || {};
      const { data: contract } = await supabase
        .from('contracts')
        .select('*')
        .eq('id', stateData.contractId)
        .single();

      if (!contract) {
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
        return NextResponse.json({ success: true });
      }

      const editText = processedBody;

      // Send feedback to freelancer and put them in EDITING mode
      await sendWhatsAppMessage(
        contract.freelancer_phone,
        `📝 *CONTRACT EDIT REQUEST — #${contract.id}*\n` +
        `Client requested the following changes before agreeing:\n\n"${editText}"\n\n` +
        `─────────────────────────\n` +
        `Current contract details:\n` +
        `*Work:* ${contract.description}\n` +
        `*Amount:* ₹${contract.amount.toLocaleString('en-IN')}\n` +
        `*Revisions:* ${contract.revisions_allowed}\n` +
        `─────────────────────────\n` +
        `What would you like to update?\n\n` +
        `1️⃣ Description\n` +
        `2️⃣ Amount\n` +
        `3️⃣ Revisions\n` +
        `✅ DONE — re-send updated contract to client`
      );

      // Put freelancer into EDITING_CONTRACT state
      await supabase.from('users').update({
        state: 'EDITING_CONTRACT',
        state_data: { contractId: contract.id }
      }).eq('phone', contract.freelancer_phone);

      await sendWhatsAppMessage(phone, `✅ Your edit request was sent to the freelancer. They will update the contract and re-send it to you.`);
      await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
      return NextResponse.json({ success: true });
    }

    // FIX #3: EDITING_CONTRACT — freelancer picks what to edit
    if (user.state === 'EDITING_CONTRACT') {
      const stateData = user.state_data || {};
      const { data: contract } = await supabase
        .from('contracts')
        .select('*')
        .eq('id', stateData.contractId)
        .single();

      if (!contract) {
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
        return NextResponse.json({ success: true });
      }

      if (command === '1') {
        await supabase.from('users').update({
          state: 'EDITING_DESC',
          state_data: { contractId: contract.id }
        }).eq('phone', phone);
        await sendWhatsAppMessage(phone, `📝 Send the updated work description:`);
      } else if (command === '2') {
        await supabase.from('users').update({
          state: 'EDITING_AMOUNT',
          state_data: { contractId: contract.id }
        }).eq('phone', phone);
        await sendWhatsAppMessage(phone, `💰 Send the updated amount (e.g. *8000*, *25k*, *1.5L*):`);
      } else if (command === '3') {
        await supabase.from('users').update({
          state: 'EDITING_REVISIONS',
          state_data: { contractId: contract.id }
        }).eq('phone', phone);
        await sendWhatsAppMessage(phone, `🔄 How many revision rounds? (0-20):`);
      } else if (command === 'DONE') {
        // Re-fetch updated contract
        const { data: updated } = await supabase
          .from('contracts')
          .select('*')
          .eq('id', contract.id)
          .single();

        if (updated) {
          const { data: flUser } = await supabase.from('users').select('name').eq('phone', phone).single();
          await sendContractCardToClient(updated, flUser?.name || 'Freelancer');
          await sendWhatsAppMessage(phone, `✅ Updated contract *#${contract.id}* has been re-sent to the client for approval.`);
        }
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
      } else {
        await sendWhatsAppMessage(phone,
          `Reply with a number to edit:\n\n` +
          `1️⃣ Description\n` +
          `2️⃣ Amount\n` +
          `3️⃣ Revisions\n` +
          `✅ DONE — re-send updated contract to client`
        );
      }
      return NextResponse.json({ success: true });
    }

    // FIX #3: EDITING_DESC — freelancer enters new description
    if (user.state === 'EDITING_DESC') {
      const stateData = user.state_data || {};
      const desc = processedBody;
      if (desc.length < 20) {
        await sendWhatsAppMessage(phone, `⚠️ Description must be at least 20 characters. Please try again.`);
        return NextResponse.json({ success: true });
      }
      await supabase.from('contracts').update({ description: desc }).eq('id', stateData.contractId);
      await supabase.from('users').update({
        state: 'EDITING_CONTRACT',
        state_data: { contractId: stateData.contractId }
      }).eq('phone', phone);
      await sendWhatsAppMessage(phone,
        `✅ Description updated!\n\nWhat else to update?\n\n` +
        `1️⃣ Description\n2️⃣ Amount\n3️⃣ Revisions\n✅ DONE — re-send to client`
      );
      return NextResponse.json({ success: true });
    }

    // FIX #3: EDITING_AMOUNT — freelancer enters new amount
    if (user.state === 'EDITING_AMOUNT') {
      const stateData = user.state_data || {};
      let amountStr = processedBody.toLowerCase().replace(/,/g, '');
      if (amountStr.endsWith('k')) amountStr = (parseFloat(amountStr) * 1000).toString();
      else if (amountStr.endsWith('l')) amountStr = (parseFloat(amountStr) * 100000).toString();
      const amount = parseInt(amountStr.replace(/[^0-9]/g, ''));

      if (isNaN(amount) || amount < 100) {
        await sendWhatsAppMessage(phone, `Minimum is ₹100. Please enter a valid amount.`);
        return NextResponse.json({ success: true });
      }
      await supabase.from('contracts').update({ amount }).eq('id', stateData.contractId);
      await supabase.from('users').update({
        state: 'EDITING_CONTRACT',
        state_data: { contractId: stateData.contractId }
      }).eq('phone', phone);
      await sendWhatsAppMessage(phone,
        `✅ Amount updated to ₹${amount.toLocaleString('en-IN')}!\n\nWhat else?\n\n` +
        `1️⃣ Description\n2️⃣ Amount\n3️⃣ Revisions\n✅ DONE — re-send to client`
      );
      return NextResponse.json({ success: true });
    }

    // FIX #3: EDITING_REVISIONS — freelancer enters new revision count
    if (user.state === 'EDITING_REVISIONS') {
      const stateData = user.state_data || {};
      const revisions = parseInt(processedBody.replace(/[^0-9]/g, ''));
      if (isNaN(revisions) || revisions < 0 || revisions > 20) {
        await sendWhatsAppMessage(phone, `Please reply with a number between 0 and 20.`);
        return NextResponse.json({ success: true });
      }
      await supabase.from('contracts').update({ revisions_allowed: revisions }).eq('id', stateData.contractId);
      await supabase.from('users').update({
        state: 'EDITING_CONTRACT',
        state_data: { contractId: stateData.contractId }
      }).eq('phone', phone);
      await sendWhatsAppMessage(phone,
        `✅ Revisions updated to ${revisions}!\n\nWhat else?\n\n` +
        `1️⃣ Description\n2️⃣ Amount\n3️⃣ Revisions\n✅ DONE — re-send to client`
      );
      return NextResponse.json({ success: true });
    }

    // STATE: DISPUTE_STATEMENT
    if (user.state === 'DISPUTE_STATEMENT') {
      const stateData = user.state_data || {};
      const { contractId, myRole } = stateData;

      const { data: contract } = await supabase
        .from('contracts')
        .select('*')
        .eq('id', contractId)
        .single();

      if (!contract) {
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
        return NextResponse.json({ success: true });
      }

      const statement = processedBody;

      await supabase.from('events').insert({
        contract_id: contractId,
        actor: myRole,
        type: 'disputed',
        content: statement
      });

      await sendWhatsAppMessage(phone, `✅ Your statement has been recorded. We are now waiting for the other party's response.`);
      await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);

      const otherRole = myRole === 'FREELANCER' ? 'CLIENT' : 'FREELANCER';
      const { data: otherStatement } = await supabase
        .from('events')
        .select('id')
        .eq('contract_id', contractId)
        .eq('type', 'disputed')
        .eq('actor', otherRole)
        .single();

      if (otherStatement) {
        await runDisputeAndNotify(contract);
      }

      return NextResponse.json({ success: true });
    }

    // STATE: NEGOTIATE_PROPOSE
    if (user.state === 'NEGOTIATE_PROPOSE') {
      const stateData = user.state_data || {};
      const { data: contract } = await supabase
        .from('contracts')
        .select('*')
        .eq('id', stateData.contractId)
        .single();

      if (!contract) {
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
        return NextResponse.json({ success: true });
      }

      let amountStr = processedBody.toLowerCase().replace(/,/g, '');
      if (amountStr.endsWith('k')) amountStr = amountStr.slice(0, -1) + '000';
      const amount = parseInt(amountStr.replace(/[^0-9]/g, ''));

      const minAmount = Math.ceil(contract.amount * 0.2);

      if (isNaN(amount) || amount <= 0) {
        await sendWhatsAppMessage(phone, `Please reply with a valid number (e.g. 15000).`);
        return NextResponse.json({ success: true });
      }
      if (amount < minAmount) {
        await sendWhatsAppMessage(phone, `⚠️ Minimum offer is ₹${minAmount.toLocaleString('en-IN')} (20% of contract). Please try a higher amount.`);
        return NextResponse.json({ success: true });
      }
      if (amount >= contract.amount) {
        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
        await handleApproval(contract);
        return NextResponse.json({ success: true });
      }

      await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
      await supabase.from('contracts').update({ active_negotiation_amount: amount }).eq('id', contract.id);

      await supabase.from('events').insert({
        contract_id: contract.id,
        actor: 'CLIENT',
        type: 'negotiate_proposed',
        content: amount.toString()
      });

      await sendWhatsAppMessage(
        contract.freelancer_phone,
        `💬 *SETTLEMENT OFFER — #${contract.id}*\n` +
        `─────────────────────────\n` +
        `Client proposes: ₹${amount.toLocaleString('en-IN')}\n` +
        `Refund to Client: ₹${(contract.amount - amount).toLocaleString('en-IN')}\n` +
        `(Original: ₹${contract.amount.toLocaleString('en-IN')})\n` +
        `─────────────────────────\n` +
        `Reply:\n✅ ACCEPT — take ₹${amount.toLocaleString('en-IN')} now\n❌ REJECT — escalate to AI dispute`
      );
      await sendWhatsAppMessage(phone, `Your settlement offer of ₹${amount.toLocaleString('en-IN')} was sent to the freelancer.`);

      return NextResponse.json({ success: true });
    }

    // =========================================================
    // FIX #4: CHECK PENDING AGREEMENT *BEFORE* falling to menu
    // This must come before the active contract check and before
    // the state machine, so that AGREE is never swallowed.
    // =========================================================
    const { data: pendingContracts } = await supabase
      .from('contracts')
      .select('*')
      .eq('client_phone', phone)
      .eq('status', 'PENDING_AGREEMENT');

    const pendingContract = pendingContracts?.[0];

    if (pendingContract) {
      if (command === 'AGREE') {
        try {
          const { razorpay } = await import('@/lib/razorpay');
          if (!razorpay) throw new Error('Razorpay not configured');

          const appUrl = process.env.NEXT_PUBLIC_APP_URL;
          if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL env variable is not set');

          const link: any = await razorpay.paymentLink.create({
            amount: pendingContract.amount * 100,
            currency: 'INR',
            description: `Arbiter Escrow — Contract #${pendingContract.id}`,
            customer: {
              name: pendingContract.client_name || user.name || 'Client',
              contact: pendingContract.client_phone,
              email: 'client@arbiter.in'
            },
            notify: { sms: false, email: false },
            callback_url: `${appUrl}api/razorpay-webhook`,
            callback_method: 'get',
            expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
          });

          await supabase
            .from('contracts')
            .update({
              client_agreed: true,
              payment_link_id: link.id,
              status: 'PENDING_PAYMENT'
            })
            .eq('id', pendingContract.id);

          await sendWhatsAppMessage(
            phone,
            `💳 *Pay to begin work on Contract #${pendingContract.id}*\n\n` +
            `Amount: ₹${pendingContract.amount.toLocaleString('en-IN')}\n\n` +
            `${link.short_url}\n\n` +
            `Pay via UPI, card, or netbanking. Funds are held in escrow and released only when you approve the work.`
          );
          await sendWhatsAppMessage(
            pendingContract.freelancer_phone,
            `🎉 The client agreed to contract *#${pendingContract.id}*! Payment link sent. You'll be notified once escrow is funded.`
          );
          return NextResponse.json({ success: true });

        } catch (e) {
          console.error('Payment Link Error:', e);
          await sendWhatsAppMessage(
            phone,
            `⚠️ We couldn't generate a payment link right now. Please try again in a moment.`
          );
          return NextResponse.json({ success: true });
        }

      } else if (command === 'EDIT') {
        await supabase.from('users').update({
          state: 'AWAITING_CONTRACT_EDIT',
          state_data: { contractId: pendingContract.id }
        }).eq('phone', phone);
        await sendWhatsAppMessage(phone, `📝 What changes would you like to request from the freelancer?`);
        return NextResponse.json({ success: true });

      } else if (command === 'MENU' || command === '1' || command === '2' || command === '3') {
        // Fall through to standard menu if requested
      } else {
        // Remind client of pending contract
        const { data: flUser } = await supabase.from('users').select('name').eq('phone', pendingContract.freelancer_phone).single();
        await sendWhatsAppMessage(
          phone,
          `📋 *CONTRACT #${pendingContract.id} is awaiting your decision.*\n\n` +
          `Work: ${pendingContract.description}\n` +
          `Amount: ₹${pendingContract.amount.toLocaleString('en-IN')}\n` +
          `Revisions: ${pendingContract.revisions_allowed}\n` +
          `Freelancer: ${flUser?.name || 'Freelancer'} (+${pendingContract.freelancer_phone})\n\n` +
          `Reply *AGREE* to pay and start, or *EDIT* to request changes.`
        );
        return NextResponse.json({ success: true });
      }
    }

    // --- CHECK ACTIVE CONTRACT (IN_PROGRESS or DISPUTED) ---
    const { data: activeContracts } = await supabase
      .from('contracts')
      .select('*')
      .or(`freelancer_phone.eq.${phone},client_phone.eq.${phone}`)
      .in('status', ['IN_PROGRESS', 'DISPUTED']);

    const activeContract = activeContracts?.[0];

    if (activeContract) {
      const isFreelancer = activeContract.freelancer_phone === phone;
      const role = isFreelancer ? 'FREELANCER' : 'CLIENT';

      const content = mediaUrl ? `[Media]: ${mediaUrl}` : processedBody;

      if (command === 'DISPUTE') {
        if (activeContract.status === 'DISPUTED') {
          await sendWhatsAppMessage(phone, `⚠️ A dispute is already in progress for contract *#${activeContract.id}*. Please wait for the ruling.`);
          return NextResponse.json({ success: true });
        }

        const otherPhone = isFreelancer ? activeContract.client_phone : activeContract.freelancer_phone;
        const otherRole = isFreelancer ? 'CLIENT' : 'FREELANCER';

        await supabase.from('contracts').update({ status: 'DISPUTED' }).eq('id', activeContract.id);

        await supabase.from('users').update({
          state: 'DISPUTE_STATEMENT',
          state_data: { contractId: activeContract.id, myRole: role, otherPhone }
        }).eq('phone', phone);

        await supabase.from('users').update({
          state: 'DISPUTE_STATEMENT',
          state_data: { contractId: activeContract.id, myRole: otherRole, otherPhone: phone }
        }).eq('phone', otherPhone);

        await sendWhatsAppMessage(
          phone,
          `⚖️ *DISPUTE RAISED — #${activeContract.id}*\n\nPlease describe your issue in one message. Cite specific facts and timestamps.`
        );
        await sendWhatsAppMessage(
          otherPhone,
          `⚠️ A dispute has been raised on contract *#${activeContract.id}*.\n\nPlease share your side of the story in one message.`
        );
        return NextResponse.json({ success: true });
      }

      // Log events
      await supabase.from('events').insert({
        contract_id: activeContract.id,
        actor: role,
        type: mediaUrl ? 'revision_submitted' : 'MESSAGE',
        content
      });

      // === FREELANCER BRANCH ===
      if (isFreelancer) {

        if (command === 'ACCEPT') {
          const settlementAmount = activeContract.active_negotiation_amount;
          if (!settlementAmount) {
            await sendWhatsAppMessage(phone, `There is no active settlement offer to accept. Type DISPUTE to escalate.`);
            return NextResponse.json({ success: true });
          }
          await supabase.from('events').insert({
            contract_id: activeContract.id,
            actor: 'FREELANCER',
            type: 'negotiate_accepted',
            content: settlementAmount.toString()
          });
          await executeSplitPayout(activeContract, settlementAmount);
          return NextResponse.json({ success: true });
        }

        if (command === 'REJECT') {
          await supabase.from('events').insert({
            contract_id: activeContract.id,
            actor: 'FREELANCER',
            type: 'negotiate_rejected',
            content: 'Freelancer rejected the settlement offer'
          });
          await supabase.from('contracts').update({ status: 'DISPUTED' }).eq('id', activeContract.id);
          await sendWhatsAppMessage(activeContract.freelancer_phone, `❌ Settlement rejected. Escalating to AI Judge...`);
          await sendWhatsAppMessage(activeContract.client_phone, `❌ The freelancer rejected your settlement. Escalating to AI Judge...`);
          await runDisputeAndNotify(activeContract);
          return NextResponse.json({ success: true });
        }

        if (activeContract.submission_status === 'AWAITING_CLIENT_REVIEW') {
          await sendWhatsAppMessage(phone, `⏳ Waiting for the client to review your last submission. You can't submit again until they respond.`);
          return NextResponse.json({ success: true });
        }

        if (mediaUrl) {
          const lastSubmit = activeContract.last_submission_at ? new Date(activeContract.last_submission_at) : null;
          const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
          const isRapid = lastSubmit && lastSubmit > tenMinsAgo;

          await supabase.from('contracts').update({
            submission_status: 'AWAITING_CLIENT_REVIEW',
            last_submission_at: new Date().toISOString()
          }).eq('id', activeContract.id);

          const revisionNote = `Revision ${activeContract.client_revision_count + 1}`;
          const warningBanner = isRapid
            ? `⚠️ *This file was submitted very quickly after the previous one. Review carefully before approving.*\n\n`
            : '';

          await sendWhatsAppMessage(
            activeContract.client_phone,
            `${warningBanner}📨 *CONTRACT #${activeContract.id} — ${revisionNote}*\n\n` +
            `The freelancer submitted work:\n${mediaUrl}\n\n` +
            `Reply:\n✅ APPROVE — release ₹${activeContract.amount.toLocaleString('en-IN')}\n🔄 REVISION — request changes\n⚖️ DISPUTE — AI Judge`
          );
          await sendWhatsAppMessage(phone, `✅ Work submitted to the client for review.`);

        } else {
          await sendWhatsAppMessage(activeContract.client_phone, `*Freelancer update:*\n${processedBody}`);
        }

      // === CLIENT BRANCH ===
      } else {

        if (command === 'APPROVE') {
          if (activeContract.submission_status !== 'AWAITING_CLIENT_REVIEW') {
            await sendWhatsAppMessage(phone, `⏳ The freelancer hasn't submitted any work yet. You can only approve after they send files.`);
            return NextResponse.json({ success: true });
          }
          if (activeContract.status === 'COMPLETED') {
            await sendWhatsAppMessage(phone, `This contract is already complete.`);
            return NextResponse.json({ success: true });
          }
          await handleApproval(activeContract);

        } else if (command === 'REVISION') {
          if (activeContract.submission_status !== 'AWAITING_CLIENT_REVIEW') {
            await sendWhatsAppMessage(phone, `⏳ The freelancer hasn't submitted any work yet.`);
            return NextResponse.json({ success: true });
          }
          if (activeContract.client_revision_count >= activeContract.revisions_allowed) {
            await sendWhatsAppMessage(
              phone,
              `⚠️ *CONTRACT #${activeContract.id} — REVISIONS EXHAUSTED*\n` +
              `You've used all ${activeContract.revisions_allowed} revision rounds.\n\n` +
              `What would you like to do?\n` +
              `✅ APPROVE — Release ₹${activeContract.amount.toLocaleString('en-IN')}\n` +
              `💬 NEGOTIATE — Propose a partial settlement\n` +
              `⚖️ DISPUTE — Let the AI Judge decide`
            );
          } else {
            await supabase.from('users').update({
              state: 'AWAITING_FEEDBACK',
              state_data: { contractId: activeContract.id }
            }).eq('phone', phone);
            const revisionsLeft = activeContract.revisions_allowed - activeContract.client_revision_count - 1;
            await sendWhatsAppMessage(
              phone,
              `🔄 Describe the changes needed (${activeContract.client_revision_count + 1} of ${activeContract.revisions_allowed} revisions, *${revisionsLeft} left after this*):`
            );
          }

        } else if (command === 'NEGOTIATE') {
          await supabase.from('users').update({
            state: 'NEGOTIATE_PROPOSE',
            state_data: { contractId: activeContract.id }
          }).eq('phone', phone);
          await sendWhatsAppMessage(
            phone,
            `💬 How much are you willing to pay? (max ₹${activeContract.amount.toLocaleString('en-IN')})\n\nType the amount in numbers (e.g. 15000).`
          );

        } else {
          await sendWhatsAppMessage(activeContract.freelancer_phone, `*Client update:*\n${processedBody}`);
        }
      }

      return NextResponse.json({ success: true });
    }

    // =========================================================
    // STATE MACHINE (User with no active contract)
    // =========================================================
    const stateData = user.state_data || {};

    switch (user.state) {

      case 'IDLE':
      case undefined:
      case null: {
        const menu =
          `*Arbiter Main Menu* ⚖️\n` +
          `─────────────────────────\n` +
          `Reply with a number:\n\n` +
          `1️⃣ Create new contract\n` +
          `2️⃣ View active contracts\n` +
          `3️⃣ How it works\n\n` +
          `_Type RESET at any time to return here._`;

        if (command === '1') {
          await supabase.from('users').update({ state: 'CONTRACT_DESC', state_data: {} }).eq('phone', phone);
          await sendWhatsAppMessage(
            phone,
            `📝 *New Contract — Step 1 of 5*\n\n` +
            `Describe the work, deliverables, and any specific requirements.\n\n` +
            `⚠️ *Be specific!* Your description is the ground truth in a dispute.\n\n` +
            `Example: _"Minimalist logo in blue/white, PNG + SVG files, 3 revision rounds"_`
          );
        } else if (command === '2') {
          const { data: myContracts } = await supabase
            .from('contracts')
            .select('*')
            .or(`freelancer_phone.eq.${phone},client_phone.eq.${phone}`)
            .in('status', ['IN_PROGRESS', 'DISPUTED', 'PENDING_PAYMENT', 'PENDING_AGREEMENT']);

          if (!myContracts || myContracts.length === 0) {
            await sendWhatsAppMessage(phone, `You have no active contracts.\n\nReply *1* to create one.`);
          } else {
            let list = `*YOUR ACTIVE CONTRACTS* ⚖️\n─────────────────────────\n`;
            myContracts.forEach((c: any, i: number) => {
              const isFL = c.freelancer_phone === phone;
              const statusEmoji = c.status === 'IN_PROGRESS' ? '🟡' : c.status === 'DISPUTED' ? '🔴' : '🔵';
              list += `${i + 1}. ${statusEmoji} *#${c.id}* — ${c.description.substring(0, 30)}...\n`;
              list += `   ₹${c.amount.toLocaleString('en-IN')} | ${isFL ? 'Freelancer' : 'Client'} | ${c.status}\n\n`;
            });
            await sendWhatsAppMessage(phone, list);
          }
        } else if (command === '3') {
          await sendWhatsAppMessage(
            phone,
            `⚖️ *How Arbiter Works*\n\n` +
            `1. Freelancer creates a contract (work + amount + revisions)\n` +
            `2. Client reviews and agrees → pays into escrow\n` +
            `3. Freelancer submits work files here\n` +
            `4. Client approves → freelancer paid instantly\n` +
            `5. If dispute → AI Judge reads evidence log and splits payment fairly\n\n` +
            `Commands:\n` +
            `• *APPROVE* — release payment\n• *REVISION* — request changes\n• *NEGOTIATE* — propose partial settlement\n• *DISPUTE* — AI Judge\n• *EDIT UPI* — update your UPI ID\n• *RESET* — return to menu`
          );
        } else {
          await sendWhatsAppMessage(phone, menu);
        }
        break;
      }

      case 'SETUP_NAME': {
        const name = processedBody;
        if (!name || name.length < 2) {
          await sendWhatsAppMessage(phone, `Please enter your full name.`);
          break;
        }
        await supabase.from('users').update({ name, state: 'SETUP_UPI' }).eq('phone', phone);
        await sendWhatsAppMessage(
          phone,
          `Nice to meet you, *${name}*! 👋\n\nPlease share your UPI ID so we can send you payments when clients approve your work.\n\nExample: *ashutosh@ybl* or *9876543210@upi*`
        );
        break;
      }

      case 'SETUP_UPI': {
        const upiId = processedBody;
        if (!/^\S+@\S+$/.test(upiId)) {
          await sendWhatsAppMessage(
            phone,
            `That doesn't look like a valid UPI ID. It must be in the format *name@bank*\n\nExamples: *ashutosh@ybl*, *9876543210@upi*, *name@okaxis*\n\nPlease try again.`
          );
          break;
        }
        await supabase.from('users').update({ upi_id: upiId, state: 'IDLE' }).eq('phone', phone);
        await sendWhatsAppMessage(
          phone,
          `✅ UPI ID *${upiId}* saved!\n\nYou're all set. Type *1* to create your first contract.`
        );
        break;
      }

      case 'CONTRACT_DESC': {
        const desc = processedBody;
        if (desc.length < 20) {
          await sendWhatsAppMessage(
            phone,
            `⚠️ *Too vague!* A specific description protects you in a dispute.\n\n` +
            `Example: _"5-page mobile-responsive website in Figma + HTML/CSS export, 3 revision rounds"_\n\n` +
            `Please send a more detailed description (at least 20 characters).`
          );
          break;
        }
        stateData.desc = desc;
        await supabase.from('users').update({ state: 'CONTRACT_AMOUNT', state_data: stateData }).eq('phone', phone);
        await sendWhatsAppMessage(phone, `📝 *New Contract — Step 2 of 5*\n\n💰 How much are you charging? (INR, numbers only)\n\nExamples: *8000*, *25000*, *1.5L*`);
        break;
      }

      case 'CONTRACT_AMOUNT': {
        let amountStr = processedBody.toLowerCase().replace(/,/g, '');
        if (amountStr.endsWith('k')) amountStr = (parseFloat(amountStr) * 1000).toString();
        else if (amountStr.endsWith('l')) amountStr = (parseFloat(amountStr) * 100000).toString();
        const amount = parseInt(amountStr.replace(/[^0-9]/g, ''));

        if (isNaN(amount) || amount < 100) {
          await sendWhatsAppMessage(phone, `Minimum contract amount is ₹100. Please enter a valid amount (e.g. *8000*).`);
          break;
        }
        stateData.amount = amount;
        await supabase.from('users').update({ state: 'CONTRACT_REVISIONS', state_data: stateData }).eq('phone', phone);
        await sendWhatsAppMessage(
          phone,
          `📝 *New Contract — Step 3 of 5*\n\n✅ Amount: ₹${amount.toLocaleString('en-IN')}\n\n🔄 How many revision rounds will you allow the client?\n\n(0 for no revisions, 3-5 is standard. Reply with a number.)`
        );
        break;
      }

      case 'CONTRACT_REVISIONS': {
        const revisions = parseInt(processedBody.replace(/[^0-9]/g, ''));
        if (isNaN(revisions) || revisions < 0 || revisions > 20) {
          await sendWhatsAppMessage(phone, `Please reply with a number between 0 and 20.`);
          break;
        }
        stateData.revisions = revisions;
        // FIX #2: Ask for client's name next
        await supabase.from('users').update({ state: 'CONTRACT_CLIENT_NAME', state_data: stateData }).eq('phone', phone);
        await sendWhatsAppMessage(
          phone,
          `📝 *New Contract — Step 4 of 5*\n\n✅ Revisions: ${revisions}\n\n👤 What is the client's name?`
        );
        break;
      }

      // FIX #2: New step — collect client name from freelancer
      case 'CONTRACT_CLIENT_NAME': {
        const clientName = processedBody;
        if (!clientName || clientName.length < 2) {
          await sendWhatsAppMessage(phone, `Please enter the client's name (at least 2 characters).`);
          break;
        }
        stateData.clientName = clientName;
        await supabase.from('users').update({ state: 'CONTRACT_CLIENT_NO', state_data: stateData }).eq('phone', phone);
        await sendWhatsAppMessage(
          phone,
          `📝 *New Contract — Step 5 of 5*\n\n✅ Client: ${clientName}\n\n📱 What is the client's 10-digit WhatsApp number?\n\n(No country code needed. Just 10 digits.)`
        );
        break;
      }

      case 'CONTRACT_CLIENT_NO': {
        const rawPhone = processedBody.replace(/[^0-9]/g, '');
        let clientPhone = rawPhone;
        if (rawPhone.length === 10) clientPhone = `91${rawPhone}`;
        else if (rawPhone.startsWith('91') && rawPhone.length === 12) clientPhone = rawPhone;
        else if (rawPhone.startsWith('0') && rawPhone.length === 11) clientPhone = `91${rawPhone.slice(1)}`;
        else {
          await sendWhatsAppMessage(phone, `That doesn't look like a valid 10-digit Indian mobile number. Please try again.`);
          break;
        }

        const cleanMyPhone = phone.replace(/\D/g, '');
        if (clientPhone === cleanMyPhone || `91${clientPhone}` === cleanMyPhone || clientPhone === `91${cleanMyPhone}`) {
          await sendWhatsAppMessage(phone, `❌ You can't create a contract with yourself.`);
          break;
        }

        const { count } = await supabase
          .from('contracts')
          .select('id', { count: 'exact', head: true })
          .eq('freelancer_phone', phone)
          .in('status', ['PENDING_AGREEMENT', 'PENDING_PAYMENT', 'IN_PROGRESS']);

        if ((count || 0) >= 5) {
          await sendWhatsAppMessage(phone, `⚠️ You've reached the limit of 5 active contracts. Complete existing ones before creating new ones.`);
          await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);
          break;
        }

        const contractId = `ARB-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        // FIX #2: Store client_name in the contract
        const insertData: any = {
          id: contractId,
          freelancer_phone: phone,
          client_phone: clientPhone,
          description: stateData.desc,
          amount: stateData.amount,
          revisions_allowed: stateData.revisions,
          freelancer_agreed: true,
          status: 'PENDING_AGREEMENT'
        };

        // Add client_name if column exists (gracefully handle if not)
        if (stateData.clientName) {
          insertData.client_name = stateData.clientName;
        }

        const { error: insertErr } = await supabase.from('contracts').insert(insertData);

        // If client_name column doesn't exist, retry without it
        if (insertErr && insertErr.message?.includes('client_name')) {
          delete insertData.client_name;
          await supabase.from('contracts').insert(insertData);
        }

        await supabase.from('users').update({ state: 'IDLE', state_data: null }).eq('phone', phone);

        // FIX #2: Show freelancer name + phone in contract card
        const contract = { ...insertData, client_name: stateData.clientName || 'Client' };
        await sendContractCardToClient(contract, user.name || 'Freelancer');

        await sendWhatsAppMessage(
          phone,
          `✅ Contract *#${contractId}* created! It has been sent to ${stateData.clientName || 'the client'} (+${clientPhone}) for approval.\n\nYou'll be notified once they agree and fund the escrow.`
        );
        break;
      }

      default:
        await sendWhatsAppMessage(phone, `I didn't understand that. Type *RESET* to go to the main menu.`);
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('WhatsApp Webhook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
