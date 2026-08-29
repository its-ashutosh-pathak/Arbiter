import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

export async function sendWhatsAppMessage(toPhone: string, message: string) {
  if (!client) {
    console.warn(`[TWILIO DISABLED] Would have sent to ${toPhone}: ${message}`);
    return;
  }
  
  try {
    const response = await client.messages.create({
      body: message,
      from: twilioNumber,
      to: `whatsapp:${toPhone}`,
    });
    console.log(`Message sent to ${toPhone}. SID: ${response.sid}`);
    return response;
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${toPhone}:`, error);
    throw error;
  }
}
